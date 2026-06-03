"use server";

import { revalidatePath } from "next/cache";
import {
  CreateRegionSchema,
  UpdateRegionSchema,
  RegionResponseSchema,
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

export async function createRegionAction(input: {
  code: string;
  name: string;
}): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateRegionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Invalid region.",
    };
  }
  try {
    const raw = await authedApiFetch<unknown>("/regions", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const validated = RegionResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    revalidatePath("/admin/regions");
    return { ok: true, data: { id: validated.data.region.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateRegionAction(
  id: string,
  changes: { name: string },
): Promise<ActionResult<{ id: string }>> {
  const parsed = UpdateRegionSchema.safeParse(changes);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Invalid change.",
    };
  }
  try {
    await authedApiFetch<unknown>(`/regions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/admin/regions");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteRegionAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(`/regions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    revalidatePath("/admin/regions");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
