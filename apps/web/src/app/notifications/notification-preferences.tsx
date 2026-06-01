"use client";

import { useState } from "react";
import type { NotificationPref } from "@cmc/contracts";
import { setPreferenceAction } from "./actions";

const KIND_LABEL: Record<string, string> = {
  "incident.assigned": "Assigned to an incident",
  "incident.transitioned": "An incident I'm involved in changes status",
};

export function NotificationPreferences({
  initial,
}: {
  initial: NotificationPref[];
}) {
  const [prefs, setPrefs] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle(kind: string, channel: "inApp" | "email") {
    const current = prefs.find((p) => p.kind === kind);
    if (!current) return;
    const next = {
      inApp: channel === "inApp" ? !current.inApp : current.inApp,
      email: channel === "email" ? !current.email : current.email,
    };
    setPrefs((prev) =>
      prev.map((p) => (p.kind === kind ? { ...p, ...next } : p)),
    );
    setBusy(true);
    await setPreferenceAction(kind, next);
    setBusy(false);
  }

  if (prefs.length === 0) return null;

  return (
    <div className="cmc-card">
      <div className="cmc-card-header">
        <span className="cmc-label">Preferences</span>
      </div>
      <div className="flex flex-col">
        <div
          className="flex items-center gap-3 px-4 py-2 text-[10px] font-semibold uppercase"
          style={{
            color: "var(--c-fg-4)",
            letterSpacing: "0.06em",
            borderBottom: "0.5px solid var(--c-line-2)",
          }}
        >
          <span className="flex-1">Notify me when…</span>
          <span style={{ width: 70, textAlign: "center" }}>In-app</span>
          <span style={{ width: 70, textAlign: "center" }}>Email</span>
        </div>
        {prefs.map((p) => (
          <div
            key={p.kind}
            className="flex items-center gap-3 px-4 py-2.5 text-[12px]"
            style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
          >
            <span className="flex-1" style={{ color: "var(--c-fg-2)" }}>
              {KIND_LABEL[p.kind] ?? p.kind}
            </span>
            <span style={{ width: 70, textAlign: "center" }}>
              <input
                type="checkbox"
                checked={p.inApp}
                disabled={busy}
                onChange={() => toggle(p.kind, "inApp")}
              />
            </span>
            <span style={{ width: 70, textAlign: "center" }}>
              <input
                type="checkbox"
                checked={p.email}
                disabled={busy}
                onChange={() => toggle(p.kind, "email")}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
