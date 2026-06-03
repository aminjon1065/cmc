"use server";

import { revalidatePath } from "next/cache";
import type {
  MediaAsset,
  MediaAssetResponse,
  MediaAssetsListResponse,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: string; message?: string } | undefined;
    if (err.status === 403) return "You don't have permission for that.";
    if (err.status === 404) return "Document not found.";
    return body?.detail ?? body?.message ?? `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function listAssetsAction(): Promise<ActionResult<MediaAsset[]>> {
  try {
    const raw = await authedApiFetch<MediaAssetsListResponse>("/media/assets");
    return { ok: true, data: raw.assets };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function requestTranscodeAction(
  documentId: string,
  watermark?: string,
): Promise<ActionResult<MediaAsset>> {
  if (!documentId.trim()) return { ok: false, error: "Document ID is required." };
  try {
    const raw = await authedApiFetch<MediaAssetResponse>("/media/transcode", {
      method: "POST",
      body: JSON.stringify({
        documentId: documentId.trim(),
        ...(watermark?.trim() ? { watermark: watermark.trim() } : {}),
      }),
    });
    revalidatePath("/media");
    return { ok: true, data: raw.asset };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
