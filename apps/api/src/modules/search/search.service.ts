import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type {
  Permission,
  SearchResponse,
  SearchResult,
  SearchResultType,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { RbacService } from "../rbac/rbac.service";

/**
 * One searchable domain: the table, its title column, the `tsvector` expression
 * (MUST match the GIN index from migration 0020 to be index-backed), and the
 * read permission that gates it.
 */
type Domain = {
  type: SearchResultType;
  table: string;
  titleExpr: string;
  tsv: string;
  perm: Permission;
};

const DOMAINS: Domain[] = [
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
  {
    type: "document",
    table: "documents",
    titleExpr: "name",
    tsv: "to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,''))",
    perm: "document:read",
  },
];

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * Cross-domain Postgres FTS (P2.11 / ADR-0041). Resolves the caller's
 * permissions, fans out a `websearch_to_tsquery` search per readable domain
 * (each RLS-scoped in the request tenant tx), and merges by `ts_rank`.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly rbac: RbacService,
  ) {}

  async search(
    tenantId: string,
    userId: string,
    rawQuery: string,
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const query = rawQuery.trim();
    const cap = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    if (query.length === 0) return { query, results: [] };

    const perms = await this.rbac.resolvePermissions(tenantId, userId);
    const allowed = DOMAINS.filter((d) => perms.has(d.perm));
    if (allowed.length === 0) return { query, results: [] };

    const results = await this.tenantDb.run(async (tx) => {
      const perDomain = await Promise.all(
        allowed.map(async (d) => {
          const rows = await tx.execute(sql`
            SELECT
              id::text AS id,
              ${sql.raw(d.titleExpr)} AS title,
              ts_rank(${sql.raw(d.tsv)}, q.query) AS score,
              nullif(left(coalesce(description, ''), 200), '') AS snippet
            FROM ${sql.raw(d.table)}, websearch_to_tsquery('simple', ${query}) AS q(query)
            WHERE deleted_at IS NULL AND ${sql.raw(d.tsv)} @@ q.query
            ORDER BY score DESC
            LIMIT ${cap}
          `);
          return (
            rows as unknown as Array<{
              id: string;
              title: string;
              score: number | string;
              snippet: string | null;
            }>
          ).map(
            (r): SearchResult => ({
              type: d.type,
              id: r.id,
              title: r.title,
              snippet: r.snippet,
              score: Number(r.score),
            }),
          );
        }),
      );
      return perDomain.flat();
    });

    results.sort((a, b) => b.score - a.score);
    return { query, results: results.slice(0, cap) };
  }
}
