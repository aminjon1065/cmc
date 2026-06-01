"use server";

import { revalidatePath } from "next/cache";
import {
  type NotificationPref,
  type NotificationSummary,
  NotificationPrefsResponseSchema,
  NotificationsListResponseSchema,
  UnreadCountResponseSchema,
} from "@cmc/contracts";
import { authedApiFetch } from "@/lib/server-api";

/** Current unread count (polled by the bell). Fails safe to 0. */
export async function getUnreadCountAction(): Promise<number> {
  try {
    const raw = await authedApiFetch<unknown>("/notifications/unread-count");
    const parsed = UnreadCountResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.unreadCount : 0;
  } catch {
    return 0;
  }
}

/** A page of the user's notifications + unread count. Fails safe to empty. */
export async function getNotificationsAction(opts: {
  unreadOnly?: boolean;
  limit?: number;
}): Promise<{ items: NotificationSummary[]; unreadCount: number }> {
  try {
    const qs = new URLSearchParams();
    if (opts.unreadOnly) qs.set("unreadOnly", "true");
    if (opts.limit) qs.set("limit", String(opts.limit));
    const raw = await authedApiFetch<unknown>(`/notifications?${qs.toString()}`);
    const parsed = NotificationsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { items: [], unreadCount: 0 };
    return {
      items: parsed.data.notifications,
      unreadCount: parsed.data.unreadCount,
    };
  } catch {
    return { items: [], unreadCount: 0 };
  }
}

export async function markReadAction(id: string): Promise<void> {
  try {
    await authedApiFetch<unknown>(
      `/notifications/${encodeURIComponent(id)}/read`,
      { method: "POST" },
    );
    revalidatePath("/notifications");
  } catch {
    // best-effort
  }
}

export async function markAllReadAction(): Promise<void> {
  try {
    await authedApiFetch<unknown>("/notifications/read-all", { method: "POST" });
    revalidatePath("/notifications");
  } catch {
    // best-effort
  }
}

export async function getPreferencesAction(): Promise<NotificationPref[]> {
  try {
    const raw = await authedApiFetch<unknown>("/notifications/preferences");
    const parsed = NotificationPrefsResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.preferences : [];
  } catch {
    return [];
  }
}

export async function setPreferenceAction(
  kind: string,
  pref: { inApp: boolean; email: boolean },
): Promise<void> {
  try {
    await authedApiFetch<unknown>(
      `/notifications/preferences/${encodeURIComponent(kind)}`,
      { method: "PUT", body: JSON.stringify(pref) },
    );
    revalidatePath("/notifications");
  } catch {
    // best-effort
  }
}
