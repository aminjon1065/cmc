import { z } from "zod";

/**
 * Cross-domain search (P2.11 / ADR-0041) — an interim Postgres FTS facade
 * (OpenSearch is Phase-3). `GET /v1/search?q=...` fans out per-domain `tsvector`
 * queries (RLS-scoped, filtered to the domains the caller can read) and merges
 * by relevance score.
 */

export const SEARCH_RESULT_TYPES = ["incident", "case", "document"] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SearchResultSchema = z.object({
  type: z.enum(SEARCH_RESULT_TYPES),
  id: z.string().uuid(),
  title: z.string(),
  /** A plain-text excerpt (no markup), or null. */
  snippet: z.string().nullable(),
  /** Postgres `ts_rank` relevance (higher = better). */
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
