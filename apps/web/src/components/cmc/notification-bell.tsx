"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bell } from "lucide-react";
import type { NotificationSummary } from "@cmc/contracts";
import {
  getNotificationsAction,
  getUnreadCountAction,
  markAllReadAction,
  markReadAction,
} from "@/app/notifications/actions";

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationBell({
  initialCount,
  initialItems,
}: {
  initialCount: number;
  initialItems: NotificationSummary[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [items, setItems] = useState(initialItems);

  // Poll the unread count so the badge stays live (no socket yet).
  useEffect(() => {
    const t = setInterval(() => {
      void getUnreadCountAction().then(setCount);
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const { items: fresh, unreadCount } = await getNotificationsAction({
        limit: 8,
      });
      setItems(fresh);
      setCount(unreadCount);
    }
  }

  async function onItem(n: NotificationSummary) {
    setOpen(false);
    if (!n.readAt) {
      await markReadAction(n.id);
      setCount((c) => Math.max(0, c - 1));
    }
    if (n.link) router.push(n.link as never);
    else router.refresh();
  }

  async function onMarkAll() {
    await markAllReadAction();
    setItems((prev) =>
      prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })),
    );
    setCount(0);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Notifications"
        style={{ position: "relative", display: "flex", alignItems: "center" }}
      >
        <Bell size={14} strokeWidth={1.6} style={{ color: "var(--c-fg-3)" }} />
        {count > 0 && (
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -7,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: 7,
              background: "var(--c-sev-1)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 600,
              lineHeight: "14px",
              textAlign: "center",
            }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 26,
            right: 0,
            width: 320,
            zIndex: 50,
            background: "var(--c-bg-1)",
            border: "0.5px solid var(--c-line-3)",
            borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
            overflow: "hidden",
          }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
          >
            <span className="cmc-label">Notifications</span>
            <div className="flex-1" />
            {count > 0 && (
              <button
                type="button"
                className="text-[10.5px]"
                style={{ color: "var(--c-accent)" }}
                onClick={onMarkAll}
              >
                Mark all read
              </button>
            )}
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {items.length === 0 ? (
              <div
                className="px-3 py-5 text-center text-[11.5px]"
                style={{ color: "var(--c-fg-4)" }}
              >
                {"You're all caught up."}
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onItem(n)}
                  className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                  style={{
                    borderBottom: "0.5px solid var(--c-line-1)",
                    background: n.readAt ? "transparent" : "var(--c-bg-2)",
                  }}
                >
                  <span
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: n.readAt ? "transparent" : "var(--c-accent)",
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[11.5px]"
                      style={{ color: "var(--c-fg-1)" }}
                    >
                      {n.title}
                    </span>
                    {n.body && (
                      <span
                        className="block truncate text-[10.5px]"
                        style={{ color: "var(--c-fg-3)" }}
                      >
                        {n.body}
                      </span>
                    )}
                    <span
                      className="cmc-mono mt-0.5 block text-[9.5px]"
                      style={{ color: "var(--c-fg-4)" }}
                    >
                      {ago(n.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          <Link
            href="/notifications"
            className="block px-3 py-2 text-center text-[11px]"
            style={{
              color: "var(--c-fg-2)",
              borderTop: "0.5px solid var(--c-line-2)",
            }}
            onClick={() => setOpen(false)}
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
