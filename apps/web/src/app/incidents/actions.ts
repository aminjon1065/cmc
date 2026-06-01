"use server";

import { revalidatePath } from "next/cache";
import {
  type CreateIncidentRequest,
  CreateIncidentRequestSchema,
  type IncidentStatus,
  type UpdateIncidentRequest,
  UpdateIncidentRequestSchema,
  IncidentDetailResponseSchema,
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

export async function createIncidentAction(
  input: CreateIncidentRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = CreateIncidentRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Invalid incident.",
    };
  }
  try {
    const raw = await authedApiFetch<unknown>("/incidents", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const validated = IncidentDetailResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    revalidatePath("/incidents");
    return { ok: true, data: { id: validated.data.incident.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateIncidentAction(
  id: string,
  changes: UpdateIncidentRequest,
): Promise<ActionResult<{ id: string }>> {
  const parsed = UpdateIncidentRequestSchema.safeParse(changes);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.errors[0]?.message ?? "Invalid change.",
    };
  }
  try {
    await authedApiFetch<unknown>(`/incidents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    });
    revalidatePath(`/incidents/${id}`);
    revalidatePath("/incidents");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function transitionIncidentAction(
  id: string,
  to: IncidentStatus,
  note?: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(
      `/incidents/${encodeURIComponent(id)}/transition`,
      { method: "POST", body: JSON.stringify({ to, note }) },
    );
    revalidatePath(`/incidents/${id}`);
    revalidatePath("/incidents");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function assignIncidentAction(
  id: string,
  userId: string | null,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(
      `/incidents/${encodeURIComponent(id)}/assign`,
      { method: "POST", body: JSON.stringify({ userId }) },
    );
    revalidatePath(`/incidents/${id}`);
    revalidatePath("/incidents");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteIncidentAction(
  id: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(`/incidents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    revalidatePath("/incidents");
    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
