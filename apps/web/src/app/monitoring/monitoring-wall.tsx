"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { MonitoringSummary } from "@cmc/contracts";
import { getMonitoringSummaryAction } from "./actions";

const SEV = [
  { n: "1", label: "SEV-1", color: "var(--c-sev-1)" },
  { n: "2", label: "SEV-2", color: "var(--c-sev-2)" },
  { n: "3", label: "SEV-3", color: "var(--c-accent)" },
  { n: "4", label: "SEV-4", color: "var(--c-fg-3)" },
  { n: "5", label: "SEV-5", color: "var(--c-fg-4)" },
];
const STATUSES = ["reported", "triaged", "in_progress", "resolved", "closed"];

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/**
 * Command-center wall (P4.3b / ADR-0062). Polls `monitoring/summary` every 4s
 * and renders live KPI tiles + an alert ticker. Polling (not WS) keeps the BFF
 * posture simple — see ADR-0062.
 */
export function MonitoringWall({
  initialSummary,
}: {
  initialSummary: MonitoringSummary;
}) {
  const t = useTranslations("monitoring");
  const [s, setS] = useState<MonitoringSummary>(initialSummary);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;
    const id = setInterval(async () => {
      const r = await getMonitoringSummaryAction();
      if (!active) return;
      if (r.ok) {
        setS(r.data);
        setStale(false);
      } else {
        setStale(true);
      }
    }, 4000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const sevMax = Math.max(1, ...SEV.map((x) => s.incidents.bySeverity[x.n] ?? 0));

  return (
    <div className="flex flex-col gap-3 p-5">
      {/* Header / liveness */}
      <div className="flex items-center gap-2">
        <span
          className="cmc-display text-[18px] font-semibold"
          style={{ color: "var(--c-fg-1)" }}
        >
          {t("commandCenter")}
        </span>
        <div className="flex-1" />
        <span
          className="flex items-center gap-1 text-[10px]"
          style={{ color: stale ? "var(--c-sev-2)" : "var(--c-accent)" }}
          title={stale ? t("reconnecting") : t("livePolling")}
        >
          <span style={{ fontSize: 8 }}>●</span>
          {stale ? t("stale") : t("live")} · {timeOf(s.generatedAt)}
        </span>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label={t("kpiActiveIncidents")}
          value={s.incidents.active}
          accent={s.incidents.active > 0 ? "var(--c-sev-1)" : "var(--c-fg-2)"}
        />
        <Kpi
          label={t("kpiSev1")}
          value={s.incidents.bySeverity["1"] ?? 0}
          accent="var(--c-sev-1)"
        />
        <Kpi label={t("kpiOpenCalls")} value={s.videoRoomsOpen} accent="var(--c-accent)" />
        <Kpi
          label={t("kpiRecentEvents")}
          value={s.recentEvents.length}
          accent="var(--c-fg-2)"
        />
      </div>

      {/* Severity + status breakdowns */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("bySeverity")}</span>
          </div>
          <div className="flex flex-col gap-2 p-4">
            {SEV.map((sev) => {
              const v = s.incidents.bySeverity[sev.n] ?? 0;
              return (
                <div key={sev.n} className="flex items-center gap-2">
                  <span
                    className="w-12 text-[11px]"
                    style={{ color: sev.color }}
                  >
                    {sev.label}
                  </span>
                  <div
                    className="h-2 rounded"
                    style={{
                      width: `${(v / sevMax) * 100}%`,
                      minWidth: v > 0 ? 6 : 0,
                      background: sev.color,
                      transition: "width 0.4s",
                    }}
                  />
                  <span
                    className="cmc-mono text-[11px]"
                    style={{ color: "var(--c-fg-3)" }}
                  >
                    {v}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("byStatus")}</span>
          </div>
          <div className="flex flex-wrap gap-2 p-4">
            {STATUSES.map((st) => (
              <div
                key={st}
                className="flex flex-col rounded-md px-3 py-2"
                style={{ background: "var(--c-bg-2)", minWidth: 92 }}
              >
                <span
                  className="cmc-mono text-[18px] font-semibold"
                  style={{ color: "var(--c-fg-1)" }}
                >
                  {s.incidents.byStatus[st] ?? 0}
                </span>
                <span className="text-[10px]" style={{ color: "var(--c-fg-4)" }}>
                  {st.replace("_", " ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent incidents + alert ticker */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="cmc-card flex flex-col" style={{ maxHeight: 360 }}>
          <div className="cmc-card-header">
            <span className="cmc-label">{t("recentIncidents")}</span>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {s.recentIncidents.length === 0 ? (
              <div className="p-2 text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("noIncidents")}
              </div>
            ) : (
              s.recentIncidents.map((i) => (
                <Link
                  key={i.id}
                  href={`/incidents/${i.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                  style={{ color: "var(--c-fg-1)" }}
                >
                  <span
                    className="cmc-mono text-[10px]"
                    style={{
                      color:
                        SEV.find((x) => x.n === String(i.severity))?.color ??
                        "var(--c-fg-3)",
                    }}
                  >
                    S{i.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {i.summary}
                  </span>
                  <span
                    className="text-[10px]"
                    style={{ color: "var(--c-fg-4)" }}
                  >
                    {i.status.replace("_", " ")}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="cmc-card flex flex-col" style={{ maxHeight: 360 }}>
          <div className="cmc-card-header">
            <span className="cmc-label">{t("alertTicker")}</span>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {s.recentEvents.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2 px-2 py-1 text-[11px]"
              >
                <span
                  style={{
                    fontSize: 7,
                    color:
                      e.outcome === "success"
                        ? "var(--c-accent)"
                        : "var(--c-sev-1)",
                  }}
                >
                  ●
                </span>
                <span className="cmc-mono" style={{ color: "var(--c-fg-4)" }}>
                  {timeOf(e.occurredAt)}
                </span>
                <span className="truncate" style={{ color: "var(--c-fg-2)" }}>
                  {e.action}
                </span>
                <div className="flex-1" />
                <span style={{ color: "var(--c-fg-4)" }}>{e.resourceType}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="cmc-card flex flex-col gap-1 p-4">
      <span
        className="cmc-mono text-[30px] font-semibold leading-none"
        style={{ color: accent }}
      >
        {value}
      </span>
      <span className="text-[11px]" style={{ color: "var(--c-fg-4)" }}>
        {label}
      </span>
    </div>
  );
}
