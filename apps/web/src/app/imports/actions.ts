"use server";

import { revalidatePath } from "next/cache";
import type {
  CreateImportRequest,
  ImportJob,
  ImportJobResponse,
  ImportJobsListResponse,
  ImportRowError,
  ImportRowErrorsListResponse,
  ImportUploadInitResponse,
  GisLayersListResponse,
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
    if (err.status === 403) return "You don't have permission for that.";
    return msg ? String(msg) : `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function listImportsAction(): Promise<
  ActionResult<ImportJob[]>
> {
  try {
    const raw = await authedApiFetch<ImportJobsListResponse>("/imports");
    return { ok: true, data: raw.jobs };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listGisLayersAction(): Promise<
  ActionResult<{ id: string; name: string }[]>
> {
  try {
    const raw = await authedApiFetch<GisLayersListResponse>("/gis/layers");
    return {
      ok: true,
      data: raw.layers.map((l) => ({ id: l.id, name: l.name })),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function initUploadAction(
  filename: string,
  contentType: string,
): Promise<ActionResult<ImportUploadInitResponse>> {
  try {
    const raw = await authedApiFetch<ImportUploadInitResponse>(
      "/imports/upload-init",
      { method: "POST", body: JSON.stringify({ filename, contentType }) },
    );
    return { ok: true, data: raw };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createImportAction(
  input: CreateImportRequest,
): Promise<ActionResult<ImportJob>> {
  try {
    const raw = await authedApiFetch<ImportJobResponse>("/imports", {
      method: "POST",
      body: JSON.stringify(input),
    });
    revalidatePath("/imports");
    return { ok: true, data: raw.job };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listErrorsAction(
  jobId: string,
): Promise<ActionResult<ImportRowError[]>> {
  try {
    const raw = await authedApiFetch<ImportRowErrorsListResponse>(
      `/imports/${jobId}/errors`,
    );
    return { ok: true, data: raw.errors };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
