"use client";

import { useCallback, useEffect, useState } from "react";
import { createIncidentAction } from "@/app/incidents/actions";
import {
  countQueuedIncidents,
  listQueuedIncidents,
  removeQueuedIncident,
} from "@/lib/offline-incidents";

/** Dispatched by forms after queuing an incident offline (see create form). */
export const QUEUE_EVENT = "cmc:queue-changed";

/**
 * PWA bootstrap (P4.4 / ADR-0075): registers the service worker, tracks
 * online/offline + the offline-incident queue depth (small status badge), and
 * **drains the queue on reconnect** by replaying each draft through the normal
 * `createIncidentAction` server action. Mounted once in the root layout.
 */
export function PwaRegister() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  const refreshCount = useCallback(async () => {
    try {
      setPending(await countQueuedIncidents());
    } catch {
      /* IndexedDB unavailable — ignore */
    }
  }, []);

  const drain = useCallback(async () => {
    let items;
    try {
      items = await listQueuedIncidents();
    } catch {
      return;
    }
    for (const it of items) {
      try {
        const res = await createIncidentAction(it.input);
        // Server was reached (success or a permanent validation reject) → drop it.
        await removeQueuedIncident(it.id);
        if (!res.ok) {
          console.warn("dropped un-syncable queued incident:", res.error);
        }
      } catch {
        break; // still offline — retry on the next reconnect
      }
    }
    await refreshCount();
  }, [refreshCount]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setOnline(navigator.onLine);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration is best-effort */
      });
    }
    const onOnline = () => {
      setOnline(true);
      void drain();
    };
    const onOffline = () => setOnline(false);
    const onQueue = () => void refreshCount();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener(QUEUE_EVENT, onQueue);
    void refreshCount();
    if (navigator.onLine) void drain();
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(QUEUE_EVENT, onQueue);
    };
  }, [drain, refreshCount]);

  if (online && pending === 0) return null;

  const message = !online
    ? pending > 0
      ? `Офлайн — ${pending} отчёт(ов) в очереди`
      : "Офлайн — приложение доступно"
    : `Синхронизация… ${pending} в очереди`;

  return (
    <div
      className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs shadow-lg"
      style={{
        background: online ? "#1b2430" : "#b45309",
        color: "#e5edf7",
      }}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}
