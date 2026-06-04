import { z } from "zod";
import { SEARCH_RESULT_TYPES } from "./search";
import { LlmUsageSchema } from "./llm";

/**
 * RAG (retrieval-augmented generation) contracts (P5.4 / ADR-0070).
 * `POST /v1/rag/ask` answers a question **strictly** from the caller's own
 * permission-filtered sources: it reuses the federated hybrid retrieval
 * (P5.3 / `/v1/search`), assembles the retrieved items' text into a numbered
 * context, and asks the LLM gateway (P5.1) to answer **only** from that context
 * with inline `[n]` citations. The audit records provenance (cited source ids),
 * not the raw question/answer (unless `LLM_LOG_PROMPTS`).
 */

export const RagAskRequestSchema = z.object({
  question: z.string().min(1).max(4000),
  /** How many sources to retrieve for grounding (defaults to `RAG_TOP_K`). */
  topK: z.number().int().min(1).max(20).optional(),
});
export type RagAskRequest = z.infer<typeof RagAskRequestSchema>;

/** A source the answer cited, by domain + id (the title aids display). */
export const RagCitationSchema = z.object({
  type: z.enum(SEARCH_RESULT_TYPES),
  id: z.string().uuid(),
  title: z.string(),
});
export type RagCitation = z.infer<typeof RagCitationSchema>;

export const RagAskResponseSchema = z.object({
  /** The grounded answer (or an explicit "no answer in sources" message). */
  answer: z.string(),
  /** Sources the answer actually cited (`[n]` markers resolved to ids). */
  citations: z.array(RagCitationSchema),
  /** True when the answer is backed by at least one cited source. */
  grounded: z.boolean(),
  model: z.string(),
  usage: LlmUsageSchema,
});
export type RagAskResponse = z.infer<typeof RagAskResponseSchema>;
