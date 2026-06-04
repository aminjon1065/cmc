import { z } from "zod";
import { RagCitationSchema } from "./rag";
import { LlmUsageSchema } from "./llm";

/**
 * Per-module copilots (P5.5 / ADR-0071). A unified `POST /v1/copilot/ask`
 * surface: a **read-only, module-scoped** assistant that grounds strictly in the
 * caller's permission-filtered module data (reusing the P5.4 RAG compose), with
 * an optional `resourceId` to anchor on a specific record ("summarize THIS
 * incident"). Same grounded/cited/audited contract as RAG. The first module is
 * `incidents`; GIS / documents / workflow are follow-ons behind the same surface.
 */

export const COPILOT_MODULES = ["incidents"] as const;
export type CopilotModule = (typeof COPILOT_MODULES)[number];

export const CopilotAskRequestSchema = z.object({
  module: z.enum(COPILOT_MODULES),
  question: z.string().min(1).max(4000),
  /** Anchor the answer on a specific record of the module (optional). */
  resourceId: z.string().uuid().optional(),
  topK: z.number().int().min(1).max(20).optional(),
});
export type CopilotAskRequest = z.infer<typeof CopilotAskRequestSchema>;

export const CopilotAskResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(RagCitationSchema),
  grounded: z.boolean(),
  model: z.string(),
  usage: LlmUsageSchema,
});
export type CopilotAskResponse = z.infer<typeof CopilotAskResponseSchema>;
