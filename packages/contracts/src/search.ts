import { z } from "zod";

/**
 * Cross-domain federated search. `GET /v1/search?q=...` fans out per-domain
 * queries (RLS-scoped, filtered to the domains the caller can read) and merges
 * by Reciprocal Rank Fusion (P3.7 / ADR-0052). Incidents + cases use Postgres
 * `tsvector` FTS (P2.11 / ADR-0041); documents use OpenSearch when enabled
 * (P3.6 / ADR-0051), falling back to FTS — both folder-access filtered.
 */

export const SEARCH_RESULT_TYPES = ["incident", "case", "document"] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

/** Which engine served a result (documents may come from either). */
export const SEARCH_SOURCES = ["opensearch", "postgres"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

export const SearchResultSchema = z.object({
  type: z.enum(SEARCH_RESULT_TYPES),
  id: z.string().uuid(),
  title: z.string(),
  /** A plain-text excerpt (no markup), or null. */
  snippet: z.string().nullable(),
  /** Fused relevance (Reciprocal Rank Fusion; higher = better). */
  score: z.number(),
  /** The engine that produced this result. */
  source: z.enum(SEARCH_SOURCES),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
