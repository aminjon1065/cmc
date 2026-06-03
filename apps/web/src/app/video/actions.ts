"use server";

import { revalidatePath } from "next/cache";
import type {
  VideoLinkType,
  VideoRecording,
  VideoRecordingDownloadResponse,
  VideoRecordingResponse,
  VideoRecordingsListResponse,
  VideoRoom,
  VideoRoomResponse,
  VideoRoomsListResponse,
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

export async function listRoomsAction(): Promise<ActionResult<VideoRoom[]>> {
  try {
    const raw = await authedApiFetch<VideoRoomsListResponse>("/video/rooms");
    return { ok: true, data: raw.rooms };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listLinkedRoomsAction(
  linkedType: VideoLinkType,
  linkedId: string,
): Promise<ActionResult<VideoRoom[]>> {
  try {
    const raw = await authedApiFetch<VideoRoomsListResponse>(
      `/video/rooms?linkedType=${linkedType}&linkedId=${encodeURIComponent(linkedId)}`,
    );
    return { ok: true, data: raw.rooms };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createRoomAction(
  name: string,
  link?: { linkedType: VideoLinkType; linkedId: string },
): Promise<ActionResult<VideoRoom>> {
  if (!name.trim()) return { ok: false, error: "Room name is required." };
  try {
    const raw = await authedApiFetch<VideoRoomResponse>("/video/rooms", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), ...(link ?? {}) }),
    });
    revalidatePath("/video");
    return { ok: true, data: raw.room };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- recordings (P4.2c) ----------

export async function listRecordingsAction(
  roomId: string,
): Promise<ActionResult<VideoRecording[]>> {
  try {
    const raw = await authedApiFetch<VideoRecordingsListResponse>(
      `/video/rooms/${roomId}/recordings`,
    );
    return { ok: true, data: raw.recordings };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function startRecordingAction(
  roomId: string,
): Promise<ActionResult<VideoRecording>> {
  try {
    const raw = await authedApiFetch<VideoRecordingResponse>(
      `/video/rooms/${roomId}/recordings`,
      { method: "POST" },
    );
    return { ok: true, data: raw.recording };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function stopRecordingAction(
  recordingId: string,
): Promise<ActionResult<VideoRecording>> {
  try {
    const raw = await authedApiFetch<VideoRecordingResponse>(
      `/video/recordings/${recordingId}/stop`,
      { method: "POST" },
    );
    return { ok: true, data: raw.recording };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function recordingDownloadAction(
  recordingId: string,
): Promise<ActionResult<string>> {
  try {
    const raw = await authedApiFetch<VideoRecordingDownloadResponse>(
      `/video/recordings/${recordingId}/download`,
    );
    return { ok: true, data: raw.url };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function closeRoomAction(
  id: string,
): Promise<ActionResult<VideoRoom>> {
  try {
    const raw = await authedApiFetch<VideoRoomResponse>(
      `/video/rooms/${id}/close`,
      { method: "POST" },
    );
    revalidatePath("/video");
    return { ok: true, data: raw.room };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
