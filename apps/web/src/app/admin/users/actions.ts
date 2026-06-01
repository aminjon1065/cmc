"use server";

import { revalidatePath } from "next/cache";
import {
  type CreateUserRequest,
  CreateUserRequestSchema,
  type UpdateUserRequest,
  UpdateUserRequestSchema,
  UserDetailResponseSchema,
  AdminResetResponseSchema,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // Surface the API's message when present (e.g. 409 duplicate email).
    const body = err.body as { message?: string | string[] } | undefined;
    const msg = Array.isArray(body?.message)
      ? body?.message.join(", ")
      : body?.message;
    return msg ? String(msg) : `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function createUserAction(
  input: CreateUserRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateUserRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid user details." };
  try {
    const raw = await authedApiFetch<unknown>("/users", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const validated = UserDetailResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    revalidatePath("/admin/users");
    return { ok: true, data: { id: validated.data.user.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateUserAction(
  id: string,
  changes: UpdateUserRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = UpdateUserRequestSchema.safeParse(changes);
  if (!parsed.success) return { ok: false, error: "Invalid change." };
  try {
    await authedApiFetch<unknown>(`/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath("/admin/users");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteUserAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(`/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    revalidatePath("/admin/users");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function assignRoleAction(
  userId: string,
  roleId: string,
): Promise<ActionResult<{ userId: string }>> {
  try {
    await authedApiFetch<unknown>(
      `/rbac/users/${encodeURIComponent(userId)}/roles`,
      { method: "POST", body: JSON.stringify({ roleId }) },
    );
    revalidatePath("/admin/users");
    return { ok: true, data: { userId } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function removeRoleAction(
  userId: string,
  roleId: string,
): Promise<ActionResult<{ userId: string }>> {
  try {
    await authedApiFetch<unknown>(
      `/rbac/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      { method: "DELETE" },
    );
    revalidatePath("/admin/users");
    return { ok: true, data: { userId } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Trigger an admin password reset (P1.3). Returns the single-use token for the
 * admin to relay out-of-band — there's no email channel yet (P1.6).
 */
export async function resetPasswordAction(
  userId: string,
): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  try {
    const raw = await authedApiFetch<unknown>(
      `/auth/password/admin-reset/${encodeURIComponent(userId)}`,
      { method: "POST" },
    );
    const validated = AdminResetResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    return {
      ok: true,
      data: { token: validated.data.token, expiresAt: validated.data.expiresAt },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
