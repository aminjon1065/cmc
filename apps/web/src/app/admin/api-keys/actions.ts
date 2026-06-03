"use server";

import { revalidatePath } from "next/cache";
import type {
  ApiKeyCreatedResponse,
  CreateApiKeyRequest,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as
      | { detail?: string; message?: string | string[] }
      | undefined;
    const msg = Array.isArray(body?.message)
      ? body?.message.join(", ")
      : (body?.detail ?? body?.message);
    return msg ? String(msg) : `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function createApiKeyAction(
  input: CreateApiKeyRequest,
): Promise<ActionResult<ApiKeyCreatedResponse>> {
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (input.scopes.length === 0)
    return { ok: false, error: "Select at least one scope." };
  try {
    const raw = await authedApiFetch<ApiKeyCreatedResponse>("/api-keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
    revalidatePath("/admin/api-keys");
    return { ok: true, data: raw };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function revokeApiKeyAction(
  id: string,
): Promise<ActionResult<null>> {
  try {
    await authedApiFetch(`/api-keys/${id}`, { method: "DELETE" });
    revalidatePath("/admin/api-keys");
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
