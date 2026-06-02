"use server";

import { revalidatePath } from "next/cache";
import type {
  ValidateWorkflowResponse,
  Workflow,
  WorkflowDefinition,
  WorkflowResponse,
  WorkflowRun,
  WorkflowRunsListResponse,
  WorkflowTrigger,
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

export async function createWorkflowAction(
  name: string,
): Promise<ActionResult<{ id: string }>> {
  if (!name.trim()) return { ok: false, error: "Name is required." };
  try {
    const raw = await authedApiFetch<WorkflowResponse>("/workflows", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    revalidatePath("/workflows");
    return { ok: true, data: { id: raw.workflow.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function saveWorkflowAction(
  id: string,
  patch: {
    name?: string;
    definition?: WorkflowDefinition;
    enabled?: boolean;
    trigger?: WorkflowTrigger;
  },
): Promise<ActionResult<Workflow>> {
  try {
    const raw = await authedApiFetch<WorkflowResponse>(`/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    revalidatePath(`/workflows/${id}`);
    revalidatePath("/workflows");
    return { ok: true, data: raw.workflow };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function validateWorkflowAction(
  definition: WorkflowDefinition,
): Promise<ActionResult<ValidateWorkflowResponse>> {
  try {
    const raw = await authedApiFetch<ValidateWorkflowResponse>(
      "/workflows/validate",
      { method: "POST", body: JSON.stringify({ definition }) },
    );
    return { ok: true, data: raw };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function runWorkflowAction(
  id: string,
  input?: Record<string, unknown>,
): Promise<ActionResult<WorkflowRun>> {
  try {
    const raw = await authedApiFetch<{ run: WorkflowRun }>(
      `/workflows/${id}/run`,
      { method: "POST", body: JSON.stringify({ input: input ?? {} }) },
    );
    return { ok: true, data: raw.run };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listRunsAction(
  id: string,
): Promise<ActionResult<WorkflowRun[]>> {
  try {
    const raw = await authedApiFetch<WorkflowRunsListResponse>(
      `/workflows/${id}/runs`,
    );
    return { ok: true, data: raw.runs };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteWorkflowAction(
  id: string,
): Promise<ActionResult<null>> {
  try {
    await authedApiFetch(`/workflows/${id}`, { method: "DELETE" });
    revalidatePath("/workflows");
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
