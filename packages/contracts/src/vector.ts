import { z } from "zod";

/**
 * Vector pipeline (P5.2 / ADR-0068) — status + reindex responses for the
 * document-embedding indexer. Semantic search over these vectors is P5.3.
 */
export const VectorStatusResponseSchema = z.object({
  /** Whether embedding is active (VECTOR_ENABLED and the LLM provider is up). */
  active: z.boolean(),
  /** Count of documents with a stored embedding in this tenant. */
  indexed: z.number().int().nonnegative(),
});
export type VectorStatusResponse = z.infer<typeof VectorStatusResponseSchema>;

export const VectorReindexResponseSchema = z.object({
  indexed: z.number().int().nonnegative(),
});
export type VectorReindexResponse = z.infer<typeof VectorReindexResponseSchema>;
