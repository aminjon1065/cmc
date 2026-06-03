"use server";

import { revalidatePath } from "next/cache";
import type {
  ProseMirrorDoc,
  WikiComment,
  WikiCommentsListResponse,
  WikiCommentResponse,
  WikiPage,
  WikiPageResponse,
  WikiPageSummary,
  WikiPagesListResponse,
  WikiPageVersion,
  WikiPageVersionsListResponse,
  WikiSpaceResponse,
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

// ---------- spaces ----------

export async function createSpaceAction(
  name: string,
  description?: string,
): Promise<ActionResult<{ id: string }>> {
  if (!name.trim()) return { ok: false, error: "Name is required." };
  try {
    const raw = await authedApiFetch<WikiSpaceResponse>("/wiki/spaces", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        ...(description?.trim() ? { description: description.trim() } : {}),
      }),
    });
    revalidatePath("/wiki");
    return { ok: true, data: { id: raw.space.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function listPages(spaceId: string): Promise<WikiPageSummary[]> {
  const raw = await authedApiFetch<WikiPagesListResponse>(
    `/wiki/spaces/${spaceId}/pages`,
  );
  return raw.pages;
}

// ---------- pages ----------

export async function createPageAction(
  spaceId: string,
  title: string,
  parentId?: string | null,
): Promise<ActionResult<{ pages: WikiPageSummary[]; id: string }>> {
  if (!title.trim()) return { ok: false, error: "Title is required." };
  try {
    const raw = await authedApiFetch<WikiPageResponse>("/wiki/pages", {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        title: title.trim(),
        ...(parentId ? { parentId } : {}),
      }),
    });
    const pages = await listPages(spaceId);
    revalidatePath(`/wiki/${spaceId}`);
    return { ok: true, data: { pages, id: raw.page.id } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function getPageAction(
  pageId: string,
): Promise<ActionResult<WikiPage>> {
  try {
    const raw = await authedApiFetch<WikiPageResponse>(`/wiki/pages/${pageId}`);
    return { ok: true, data: raw.page };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function savePageAction(
  pageId: string,
  patch: { title?: string; content?: ProseMirrorDoc },
): Promise<ActionResult<WikiPage>> {
  try {
    const raw = await authedApiFetch<WikiPageResponse>(`/wiki/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { ok: true, data: raw.page };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deletePageAction(
  spaceId: string,
  pageId: string,
): Promise<ActionResult<{ pages: WikiPageSummary[] }>> {
  try {
    await authedApiFetch(`/wiki/pages/${pageId}`, { method: "DELETE" });
    const pages = await listPages(spaceId);
    revalidatePath(`/wiki/${spaceId}`);
    return { ok: true, data: { pages } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- versions ----------

export async function listVersionsAction(
  pageId: string,
): Promise<ActionResult<WikiPageVersion[]>> {
  try {
    const raw = await authedApiFetch<WikiPageVersionsListResponse>(
      `/wiki/pages/${pageId}/versions`,
    );
    return { ok: true, data: raw.versions };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function restoreVersionAction(
  pageId: string,
  versionNo: number,
): Promise<ActionResult<WikiPage>> {
  try {
    const raw = await authedApiFetch<WikiPageResponse>(
      `/wiki/pages/${pageId}/versions/${versionNo}/restore`,
      { method: "POST" },
    );
    return { ok: true, data: raw.page };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ---------- comments ----------

export async function listCommentsAction(
  pageId: string,
): Promise<ActionResult<WikiComment[]>> {
  try {
    const raw = await authedApiFetch<WikiCommentsListResponse>(
      `/wiki/pages/${pageId}/comments`,
    );
    return { ok: true, data: raw.comments };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createCommentAction(
  pageId: string,
  body: string,
  parentId?: string | null,
  /** Anchored comment (P4.1c): encoded Yjs relative positions + quoted text. */
  anchor?: { anchor: string; anchorText: string },
): Promise<ActionResult<WikiComment>> {
  if (!body.trim()) return { ok: false, error: "Comment is empty." };
  try {
    const raw = await authedApiFetch<WikiCommentResponse>(
      `/wiki/pages/${pageId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          ...(parentId ? { parentId } : {}),
          ...(anchor
            ? { anchor: anchor.anchor, anchorText: anchor.anchorText }
            : {}),
        }),
      },
    );
    return { ok: true, data: raw.comment };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteCommentAction(
  commentId: string,
): Promise<ActionResult<null>> {
  try {
    await authedApiFetch(`/wiki/comments/${commentId}`, { method: "DELETE" });
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
