"use server";

import { revalidatePath } from "next/cache";
import type {
  ChatChannel,
  ChatChannelResponse,
  ChatChannelsListResponse,
  ChatMessage,
  ChatMessageResponse,
  ChatMessagesListResponse,
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

export async function listChannelsAction(): Promise<
  ActionResult<ChatChannel[]>
> {
  try {
    const raw = await authedApiFetch<ChatChannelsListResponse>("/chat/channels");
    return { ok: true, data: raw.channels };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createChannelAction(
  name: string,
  description?: string,
): Promise<ActionResult<ChatChannel>> {
  if (!name.trim()) return { ok: false, error: "Name is required." };
  try {
    const raw = await authedApiFetch<ChatChannelResponse>("/chat/channels", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        ...(description?.trim() ? { description: description.trim() } : {}),
      }),
    });
    revalidatePath("/chat");
    return { ok: true, data: raw.channel };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listMessagesAction(
  channelId: string,
  before?: string,
): Promise<ActionResult<{ messages: ChatMessage[]; nextBefore: string | null }>> {
  try {
    const qs = before ? `?before=${encodeURIComponent(before)}` : "";
    const raw = await authedApiFetch<ChatMessagesListResponse>(
      `/chat/channels/${channelId}/messages${qs}`,
    );
    return { ok: true, data: { messages: raw.messages, nextBefore: raw.nextBefore } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function listRepliesAction(
  messageId: string,
): Promise<ActionResult<ChatMessage[]>> {
  try {
    const raw = await authedApiFetch<ChatMessagesListResponse>(
      `/chat/messages/${messageId}/replies`,
    );
    return { ok: true, data: raw.messages };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function postMessageAction(
  channelId: string,
  body: string,
  parentId?: string,
): Promise<ActionResult<ChatMessage>> {
  if (!body.trim()) return { ok: false, error: "Message is empty." };
  try {
    const raw = await authedApiFetch<ChatMessageResponse>(
      `/chat/channels/${channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          ...(parentId ? { parentId } : {}),
        }),
      },
    );
    return { ok: true, data: raw.message };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteMessageAction(
  messageId: string,
): Promise<ActionResult<null>> {
  try {
    await authedApiFetch(`/chat/messages/${messageId}`, { method: "DELETE" });
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function toggleReactionAction(
  messageId: string,
  emoji: string,
  on: boolean,
): Promise<ActionResult<ChatMessage>> {
  try {
    const raw = on
      ? await authedApiFetch<ChatMessageResponse>(
          `/chat/messages/${messageId}/reactions`,
          { method: "POST", body: JSON.stringify({ emoji }) },
        )
      : await authedApiFetch<ChatMessageResponse>(
          `/chat/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
          { method: "DELETE" },
        );
    return { ok: true, data: raw.message };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
