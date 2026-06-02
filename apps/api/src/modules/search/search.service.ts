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
 * Federated cross-domain search (P3.7 / ADR-0052). Incidents + cases come from
 * Postgres FTS (P2.11); documents come from OpenSearch when enabled (P3.6),
 * falling back to FTS — both folder-access filtered (P3.3b). Each domain is
 * gated by the caller's read permission and RLS-scoped to the tenant. The
 * per-domain ranked lists are fused by Reciprocal Rank Fusion, so OpenSearch
 * BM25 and Postgres `ts_rank` (incompatible scales) merge by rank, not by raw
 * score.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly rbac: RbacService,
    private readonly folderAccess: FolderAccessService,
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

    // OpenSearch is an external call + the folder-access context does its own
    // tx — resolve both BEFORE the request tx to avoid nesting `tenantDb.run`.
    const docHits =
      canDocs && this.searchIndex.active
        ? await this.searchIndex.search(tenantId, query, cap)
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
      let docList: RankedHit[] = [];
      if (canDocs) {
        docList = docHits
          ? await this.hydrateOpenSearch(tx, docHits, folderCond)
          : await this.documentFts(tx, query, cap, folderCond);
      }
      return [...ftsLists, docList];
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
   * Hydrate OpenSearch document hits: fetch the ids in one RLS-scoped query that
   * also applies the folder-access predicate (so restricted-subtree docs the
   * caller can't read + any stray cross-tenant id drop out), then restore the
   * OpenSearch relevance order.
   */
  private async hydrateOpenSearch(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    hits: { id: string; score: number }[],
    folderCond: ReturnType<FolderAccessService["documentListCondition"]>,
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
    // Walk the hits in OpenSearch order, keeping those that survived hydration.
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is (typeof rows)[number] => r != null)
      .map((r) => ({
        type: "document" as const,
        id: r.id,
        title: r.title,
        snippet: snippetOf(r.description),
        source: "opensearch" as const,
        rawScore: score.get(r.id) ?? 0,
      }));
  }

  /**
   * Reciprocal Rank Fusion: every hit's fused score is `1/(k + rank)` by its
   * position within its own domain list (rank is 1-based). Disjoint domains, so
   * each item contributes one term; ties (same rank across domains) break by raw
   * score then id for determinism.
   */
  private fuse(lists: RankedHit[][], cap: number): SearchResult[] {
    const fused = lists.flatMap((list) =>
      list.map((hit, i) => ({ hit, rrf: 1 / (RRF_K + i + 1) })),
    );
    fused.sort(
      (a, b) =>
        b.rrf - a.rrf ||
        b.hit.rawScore - a.hit.rawScore ||
        (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
    );
    return fused.slice(0, cap).map(({ hit, rrf }) => ({
      type: hit.type,
      id: hit.id,
      title: hit.title,
      snippet: hit.snippet,
      score: rrf,
      source: hit.source,
    }));
  }
}
