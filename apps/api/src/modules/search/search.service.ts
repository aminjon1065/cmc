import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  Permission,
  SearchResponse,
  SearchResult,
  SearchResultType,
  SearchSource,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { RbacService } from "../rbac/rbac.service";
import { FolderAccessService } from "../folders/folder-access.service";
import { VectorIndexService } from "../vector/vector-index.service";
import { SEARCH_INDEX, type SearchIndex } from "./search-index";

/**
 * A Postgres-FTS domain: the table, its title column, the `tsvector` expression
 * (MUST match the GIN index from migration 0020 to be index-backed), and the
 * read permission that gates it.
 */
type FtsDomain = {
  type: SearchResultType;
  table: string;
  titleExpr: string;
  tsv: string;
  perm: Permission;
};

/** Incidents + cases search via Postgres FTS (documents are handled specially). */
const FTS_DOMAINS: FtsDomain[] = [
  {
    type: "incident",
    table: "incidents",
    titleExpr: "summary",
    tsv: "to_tsvector('simple', coalesce(summary,'') || ' ' || coalesce(description,'') || ' ' || coalesce(type,'') || ' ' || coalesce(region,''))",
    perm: "incident:read",
  },
  {
    type: "case",
    table: "cases",
    titleExpr: "title",
    tsv: "to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(type,''))",
    perm: "case:read",
  },
];

const DOCUMENT_TSV =
  "to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** Reciprocal Rank Fusion constant (the conventional default). */
const RRF_K = 60;

/** An intermediate hit: a domain's result with its within-domain rank. */
type RankedHit = {
  type: SearchResultType;
  id: string;
  title: string;
  snippet: string | null;
  source: SearchSource;
  rawScore: number; // the source's own score — only a deterministic tiebreak
};

function snippetOf(description: string | null | undefined): string | null {
  const s = (description ?? "").slice(0, 200).trim();
  return s.length > 0 ? s : null;
}

/**
 * Federated cross-domain search (P3.7 / ADR-0052; P5.3 / ADR-0069). Incidents +
 * cases come from Postgres FTS (P2.11); documents come from OpenSearch when
 * enabled (P3.6), falling back to FTS, and — when the vector pipeline is live
 * (P5.2) — additionally from a **semantic kNN lane** (brute-force cosine over the
 * embeddings). Every document lane is folder-access filtered (P3.3b). Each domain
 * is gated by the caller's read permission and RLS-scoped to the tenant. The
 * per-lane ranked lists are fused by Reciprocal Rank Fusion (summed per item), so
 * OpenSearch BM25, Postgres `ts_rank`, and cosine (incompatible scales) merge by
 * rank — and a document found by both keyword and vector is deduped to one
 * `hybrid` hit with a boosted score.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly rbac: RbacService,
    private readonly folderAccess: FolderAccessService,
    private readonly vector: VectorIndexService,
    @Inject(SEARCH_INDEX) private readonly searchIndex: SearchIndex,
  ) {}

  async search(
    tenantId: string,
    userId: string,
    rawQuery: string,
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const query = rawQuery.trim();
    const cap = Math.min(
      Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    if (query.length === 0) return { query, results: [] };

    const perms = await this.rbac.resolvePermissions(tenantId, userId);
    const ftsAllowed = FTS_DOMAINS.filter((d) => perms.has(d.perm));
    const canDocs = perms.has("document:read");
    if (ftsAllowed.length === 0 && !canDocs) return { query, results: [] };

    // OpenSearch + the vector kNN both make an external call, and the vector
    // lane + the folder-access context run their own `tenantDb.run` — resolve all
    // of them BEFORE the request tx to avoid nesting `tenantDb.run`.
    const docHits =
      canDocs && this.searchIndex.active
        ? await this.searchIndex.search(tenantId, query, cap)
        : null;
    const vecHits =
      canDocs && this.vector.active
        ? await this.vector.similar(query, cap)
        : null;
    const folderCond = canDocs
      ? this.folderAccess.documentListCondition(
          await this.folderAccess.resolveContext(),
        )
      : null;

    const lists = await this.tenantDb.run(async (tx) => {
      const ftsLists = await Promise.all(
        ftsAllowed.map((d) => this.ftsSearch(tx, d, query, cap)),
      );
      const docLists: RankedHit[][] = [];
      if (canDocs) {
        // Keyword lane: OpenSearch when enabled, else Postgres FTS fallback.
        docLists.push(
          docHits
            ? await this.hydrateDocHits(tx, docHits, folderCond, "opensearch")
            : await this.documentFts(tx, query, cap, folderCond),
        );
        // Semantic lane (P5.3): folder-access-filtered like the keyword lane;
        // a doc in both lanes is deduped + relabelled `hybrid` by `fuse`.
        if (vecHits && vecHits.length > 0) {
          docLists.push(
            await this.hydrateDocHits(tx, vecHits, folderCond, "vector"),
          );
        }
      }
      return [...ftsLists, ...docLists];
    });

    return { query, results: this.fuse(lists, cap) };
  }

  /** Generic Postgres FTS for a domain (incidents/cases). Ordered best-first. */
  private async ftsSearch(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    d: FtsDomain,
    query: string,
    cap: number,
  ): Promise<RankedHit[]> {
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id,
        ${sql.raw(d.titleExpr)} AS title,
        ts_rank(${sql.raw(d.tsv)}, q.query) AS score,
        nullif(left(coalesce(description, ''), 200), '') AS snippet
      FROM ${sql.raw(d.table)}, websearch_to_tsquery('simple', ${query}) AS q(query)
      WHERE deleted_at IS NULL AND ${sql.raw(d.tsv)} @@ q.query
      ORDER BY score DESC
      LIMIT ${cap}
    `)) as unknown as Array<{
      id: string;
      title: string;
      score: number | string;
      snippet: string | null;
    }>;
    return rows.map((r) => ({
      type: d.type,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      source: "postgres" as const,
      rawScore: Number(r.score),
    }));
  }

  /**
   * Document FTS fallback (index disabled) — folder-access filtered + ready only,
   * closing the P3.3b gap the original `/v1/search` had for documents.
   */
  private async documentFts(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    query: string,
    cap: number,
    folderCond: ReturnType<FolderAccessService["documentListCondition"]>,
  ): Promise<RankedHit[]> {
    const accessSql = folderCond ? sql` AND ${folderCond}` : sql``;
    const rows = (await tx.execute(sql`
      SELECT
        id::text AS id,
        name AS title,
        ts_rank(${sql.raw(DOCUMENT_TSV)}, q.query) AS score,
        nullif(left(coalesce(description, ''), 200), '') AS snippet
      FROM documents, websearch_to_tsquery('simple', ${query}) AS q(query)
      WHERE deleted_at IS NULL AND status = 'ready'
        AND ${sql.raw(DOCUMENT_TSV)} @@ q.query${accessSql}
      ORDER BY score DESC
      LIMIT ${cap}
    `)) as unknown as Array<{
      id: string;
      title: string;
      score: number | string;
      snippet: string | null;
    }>;
    return rows.map((r) => ({
      type: "document" as const,
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      source: "postgres" as const,
      rawScore: Number(r.score),
    }));
  }

  /**
   * Hydrate document hits from a ranked `{id, score}[]` (OpenSearch BM25 or the
   * P5.3 vector kNN): fetch the ids in one RLS-scoped query that also applies the
   * folder-access predicate (so restricted-subtree docs the caller can't read +
   * any stray cross-tenant id drop out) and is `ready`-only, then restore the
   * source's relevance order. `source` labels the lane for the response.
   */
  private async hydrateDocHits(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    hits: { id: string; score: number }[],
    folderCond: ReturnType<FolderAccessService["documentListCondition"]>,
    source: SearchSource,
  ): Promise<RankedHit[]> {
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.id);
    const filters = [
      inArray(schema.documents.id, ids),
      isNull(schema.documents.deletedAt),
      eq(schema.documents.status, "ready"),
    ];
    if (folderCond) filters.push(folderCond);
    const rows = await tx
      .select({
        id: schema.documents.id,
        title: schema.documents.name,
        description: schema.documents.description,
      })
      .from(schema.documents)
      .where(and(...filters));

    const byId = new Map(rows.map((r) => [r.id, r]));
    const score = new Map(hits.map((h) => [h.id, h.score]));
    // Walk the hits in source-relevance order, keeping those that survived
    // hydration (folder-access + lifecycle filtering applies to every lane).
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => r != null)
      .map((r) => ({
        type: "document" as const,
        id: r.id,
        title: r.title,
        snippet: snippetOf(r.description),
        source,
        rawScore: score.get(r.id) ?? 0,
      }));
  }

  /**
   * Reciprocal Rank Fusion: each hit contributes `1/(k + rank)` by its 1-based
   * position within its own lane, and contributions are **summed per (type, id)**.
   * So a document that ranks in both the keyword and the semantic lane (P5.3)
   * gets a boosted, single fused score (deduped); for the disjoint lanes
   * (incidents, cases, keyword-only documents) this is identical to one term per
   * item, so the P3.7 behaviour is unchanged. A hit fused from more than one
   * distinct lane is reported as `hybrid`, keeping the best available snippet.
   * Ties break by the larger raw score, then id, for determinism.
   */
  private fuse(lists: RankedHit[][], cap: number): SearchResult[] {
    type Agg = {
      hit: RankedHit;
      rrf: number;
      rawMax: number;
      sources: Set<SearchSource>;
    };
    const byKey = new Map<string, Agg>();
    for (const list of lists) {
      list.forEach((hit, i) => {
        const key = `${hit.type}:${hit.id}`;
        const inc = 1 / (RRF_K + i + 1);
        const cur = byKey.get(key);
        if (!cur) {
          byKey.set(key, {
            hit,
            rrf: inc,
            rawMax: hit.rawScore,
            sources: new Set([hit.source]),
          });
          return;
        }
        cur.rrf += inc;
        cur.rawMax = Math.max(cur.rawMax, hit.rawScore);
        cur.sources.add(hit.source);
        if (!cur.hit.snippet && hit.snippet) {
          cur.hit = { ...cur.hit, snippet: hit.snippet };
        }
      });
    }
    return [...byKey.values()]
      .sort(
        (a, b) =>
          b.rrf - a.rrf ||
          b.rawMax - a.rawMax ||
          (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
      )
      .slice(0, cap)
      .map(({ hit, rrf, sources }) => ({
        type: hit.type,
        id: hit.id,
        title: hit.title,
        snippet: hit.snippet,
        score: rrf,
        source: sources.size > 1 ? ("hybrid" as const) : hit.source,
      }));
  }
}
