"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { NotificationPref } from "@cmc/contracts";
import { setPreferenceAction } from "./actions";

export function NotificationPreferences({
  initial,
}: {
  initial: NotificationPref[];
}) {
  const t = useTranslations("notifications");
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
        <span className="cmc-label">{t("preferences")}</span>
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
          <span className="flex-1">{t("notifyMeWhen")}</span>
          <span style={{ width: 70, textAlign: "center" }}>{t("inApp")}</span>
          <span style={{ width: 70, textAlign: "center" }}>{t("email")}</span>
        </div>
        {prefs.map((p) => (
          <div
            key={p.kind}
            className="flex items-center gap-3 px-4 py-2.5 text-[12px]"
            style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
          >
            <span className="flex-1" style={{ color: "var(--c-fg-2)" }}>
              {p.kind === "incident.assigned"
                ? t("kindAssigned")
                : p.kind === "incident.transitioned"
                  ? t("kindTransitioned")
                  : p.kind}
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
