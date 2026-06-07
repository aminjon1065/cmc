"use server";

import { RagAskResponseSchema, type RagAskResponse } from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

/**
 * AI Assistant action (web) — calls the RAG endpoint (`POST /v1/rag/ask`,
 * P5.4 / ADR-0070) through the BFF so the API token stays server-side. The
 * answer is grounded strictly in the caller's own permission-filtered sources.
 *
 * Error shapes are mapped to stable keys the client localizes:
 *   503 → errDisabled (LLM gateway off), 429 → errRate, 502 → errProvider,
 *   403 → errForbidden, other → errApi/errShape/errFailed.
 */
export type AiAskResult =
  | { ok: true; data: RagAskResponse }
  | {
      ok: false;
      errorKey:
        | "errDisabled"
        | "errRate"
        | "errProvider"
        | "errForbidden"
        | "errApi"
        | "errShape"
        | "errFailed";
      status?: number;
    };

export async function askAiAction(question: string): Promise<AiAskResult> {
  const q = question.trim();
  if (!q) return { ok: false, errorKey: "errFailed" };
  try {
    const raw = await authedApiFetch<unknown>("/rag/ask", {
      method: "POST",
      body: JSON.stringify({ question: q }),
    });
    const parsed = RagAskResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      switch (err.status) {
        case 503:
          return { ok: false, errorKey: "errDisabled" };
        case 429:
          return { ok: false, errorKey: "errRate" };
        case 502:
          return { ok: false, errorKey: "errProvider" };
        case 403:
          return { ok: false, errorKey: "errForbidden" };
        default:
          return { ok: false, errorKey: "errApi", status: err.status };
      }
    }
    return { ok: false, errorKey: "errFailed" };
  }
}
