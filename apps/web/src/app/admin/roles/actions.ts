"use server";

import { revalidatePath } from "next/cache";
import {
  type CreateRoleRequest,
  CreateRoleRequestSchema,
  type UpdateRoleRequest,
  UpdateRoleRequestSchema,
  RoleDetailResponseSchema,
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

export async function createRoleAction(
  input: CreateRoleRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateRoleRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid role." };
  }
  try {
    const raw = await authedApiFetch<unknown>("/rbac/roles", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const validated = RoleDetailResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    revalidatePath("/admin/roles");
    return { ok: true, data: { id: validated.data.role.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateRoleAction(
  id: string,
  changes: UpdateRoleRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = UpdateRoleRequestSchema.safeParse(changes);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid change." };
  }
  try {
    await authedApiFetch<unknown>(`/rbac/roles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/admin/roles");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteRoleAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(`/rbac/roles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    revalidatePath("/admin/roles");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
