"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NotificationSummary } from "@cmc/contracts";
import { markAllReadAction, markReadAction } from "./actions";

function fmt(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

export function NotificationsView({
  initial,
}: {
  initial: NotificationSummary[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const unread = items.filter((i) => !i.readAt).length;

  async function onItem(n: NotificationSummary) {
    if (!n.readAt) {
      await markReadAction(n.id);
      setItems((prev) =>
        prev.map((i) =>
          i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i,
        ),
      );
    }
    if (n.link) router.push(n.link as never);
  }

  async function onAll() {
    setBusy(true);
    await markAllReadAction();
    setItems((prev) =>
      prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })),
    );
    setBusy(false);
  }

  return (
    <div className="cmc-card">
      <div className="cmc-card-header">
        <span className="cmc-label">
          All notifications {unread > 0 ? `· ${unread} unread` : ""}
        </span>
        <div className="flex-1" />
        {unread > 0 && (
          <button
            type="button"
            className="cmc-btn cmc-btn-ghost text-[10.5px]"
            onClick={onAll}
            disabled={busy}
          >
            Mark all read
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div
          className="p-6 text-center text-[12px]"
          style={{ color: "var(--c-fg-3)" }}
        >
          {"You're all caught up."}
        </div>
      ) : (
        <div className="flex flex-col">
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onItem(n)}
              className="flex items-start gap-2.5 px-4 py-3 text-left"
              style={{
                borderBottom: "0.5px solid var(--c-line-1)",
                background: n.readAt ? "transparent" : "var(--c-bg-2)",
              }}
            >
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: n.readAt ? "transparent" : "var(--c-accent)" }}
              />
              <span className="min-w-0 flex-1">
                <span
                  className="block text-[12px]"
                  style={{ color: "var(--c-fg-1)" }}
                >
                  {n.title}
                </span>
                {n.body && (
                  <span
                    className="block text-[11px]"
                    style={{ color: "var(--c-fg-3)" }}
                  >
                    {n.body}
                  </span>
                )}
              </span>
              <span
                className="cmc-mono shrink-0 text-[10px]"
                style={{ color: "var(--c-fg-4)" }}
              >
                {fmt(n.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
