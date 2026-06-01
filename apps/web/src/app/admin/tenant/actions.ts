"use server";

import { revalidatePath } from "next/cache";
import {
  type UpdateBrandingRequest,
  UpdateBrandingRequestSchema,
  type UpdateTenantRequest,
  UpdateTenantRequestSchema,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string | string[] } | undefined;
    const msg = Array.isArray(body?.message)
      ? body?.message.join(", ")
      : body?.message;
    return msg ? String(msg) : `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function updateTenantAction(
  input: UpdateTenantRequest,
): Promise<ActionResult<{ name: string }>> {
  const parsed = UpdateTenantRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid name." };
  }
  try {
    await authedApiFetch<unknown>("/tenant", {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/admin/tenant");
    return { ok: true, data: { name: parsed.data.name } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateBrandingAction(
  input: UpdateBrandingRequest,
): Promise<ActionResult<Record<string, never>>> {
  const parsed = UpdateBrandingRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Invalid branding.",
    };
  }
  try {
    await authedApiFetch<unknown>("/branding", {
      method: "PUT",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/admin/tenant");
    return { ok: true, data: {} };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
