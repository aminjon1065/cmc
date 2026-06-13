import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
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

/**
 * Cross-domain search (P2.11 / ADR-0041). Incidents + cases + documents all come
 * from **Postgres FTS** (ToR §8; OpenSearch + the semantic/vector lane were
 * removed in ADR-0080). Documents are matched on name/description and folder-
 * access filtered (P3.3b); every domain is gated by the caller's read permission
 * and RLS-scoped. The per-domain ranked lists are fused by Reciprocal Rank
 * Fusion so the (incompatible) `ts_rank` scales merge by rank.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly rbac: RbacService,
    private readonly folderAccess: FolderAccessService,
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

    // Resolve the folder-access context BEFORE the request tx to avoid nesting
    // `tenantDb.run`.
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
        docLists.push(await this.documentFts(tx, query, cap, folderCond));
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
