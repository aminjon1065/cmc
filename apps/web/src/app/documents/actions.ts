"use server";

import { revalidatePath } from "next/cache";
import {
  DownloadUrlResponseSchema,
  FinalizeUploadResponseSchema,
  type UploadInitRequest,
  UploadInitRequestSchema,
  UploadInitResponseSchema,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function initUploadAction(
  input: UploadInitRequest,
): Promise<ActionResult<{ documentId: string; uploadUrl: string; headers: Record<string, string> }>> {
  const parsed = UploadInitRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid upload metadata." };
  }

  try {
    const raw = await authedApiFetch<unknown>("/documents/upload-init", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    const validated = UploadInitResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    return {
      ok: true,
      data: {
        documentId: validated.data.document.id,
        uploadUrl: validated.data.upload.url,
        headers: validated.data.upload.headers,
      },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function finalizeUploadAction(
  documentId: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const raw = await authedApiFetch<unknown>(
      `/documents/${encodeURIComponent(documentId)}/finalize`,
      { method: "POST" },
    );
    const validated = FinalizeUploadResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    revalidatePath("/documents");
    return { ok: true, data: { id: validated.data.document.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function getDownloadUrlAction(
  documentId: string,
): Promise<ActionResult<{ url: string }>> {
  try {
    const raw = await authedApiFetch<unknown>(
      `/documents/${encodeURIComponent(documentId)}/download-url`,
    );
    const validated = DownloadUrlResponseSchema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: "API returned an unexpected shape." };
    }
    return { ok: true, data: { url: validated.data.url } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteDocumentAction(
  documentId: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    await authedApiFetch<unknown>(
      `/documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE" },
    );
    revalidatePath("/documents");
    return { ok: true, data: { id: documentId } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return `API ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}
