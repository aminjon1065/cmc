import { z } from "zod";

/**
 * LLM gateway contracts (P5.1 / ADR-0067). A thin, provider-agnostic chat
 * completion surface over a self-hosted, OpenAI-compatible endpoint (vLLM /
 * Ollama / llama.cpp). The gateway adds per-tenant rate-limiting + audit; the
 * actual model serving is a live/manual boundary (no GPU in CI).
 */

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(32_000),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const LlmCompleteRequestSchema = z.object({
  messages: z.array(LlmMessageSchema).min(1).max(50),
  /** Override the gateway's default model. */
  model: z.string().max(100).optional(),
  maxTokens: z.number().int().positive().max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type LlmCompleteRequest = z.infer<typeof LlmCompleteRequestSchema>;

export const LlmUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const LlmCompleteResponseSchema = z.object({
  content: z.string(),
  model: z.string(),
  usage: LlmUsageSchema,
  finishReason: z.string(),
});
export type LlmCompleteResponse = z.infer<typeof LlmCompleteResponseSchema>;
