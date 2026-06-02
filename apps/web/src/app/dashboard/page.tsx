import type { Metadata } from "next";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { auth } from "@/auth";
import { authedApiFetch } from "@/lib/server-api";
import {
  type DashboardAnalyticsResponse,
  DashboardAnalyticsResponseSchema,
  type IncidentStatsResponse,
  IncidentStatsResponseSchema,
  type IncidentSummary,
  IncidentsListResponseSchema,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { KPI } from "@/components/cmc/kpi";
import { PercentBar } from "@/components/cmc/percent-bar";
import { TrendChart } from "@/components/cmc/trend-chart";
import { SeverityBadge } from "@/components/cmc/incident-badges";

export const metadata: Metadata = {
  title: "Dashboard",
};

const BAR_COLORS = [
  "var(--c-sev-1)",
  "var(--c-sev-2)",
  "var(--c-sev-3)",
  "var(--c-info)",
  "var(--c-violet)",
  "var(--c-ok)",
];

function fmt(ts: string): string {
  return new Date(ts).toISOString().slice(5, 16).replace("T", " ");
}

async function fetchStats(): Promise<IncidentStatsResponse | null> {
  try {
    const raw = await authedApiFetch<unknown>("/incidents/stats");
    const parsed = IncidentStatsResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function fetchPriority(): Promise<IncidentSummary[]> {
  try {
    const raw = await authedApiFetch<unknown>("/incidents?active=true&limit=6");
    const parsed = IncidentsListResponseSchema.safeParse(raw);
    if (!parsed.success) return [];
    // Most pressing first: severity asc (1 = most severe), then most recent.
    return [...parsed.data.incidents].sort(
      (a, b) =>
        a.severity - b.severity ||
        b.occurredAt.localeCompare(a.occurredAt),
    );
  } catch {
    return [];
  }
}

/** ClickHouse-backed incident trend over the last 14 days (P2.6 / ADR-0036). */
async function fetchTrend(): Promise<DashboardAnalyticsResponse | null> {
  try {
    const raw = await authedApiFetch<unknown>("/analytics/dashboard?days=14");
    const parsed = DashboardAnalyticsResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [stats, priority, trend] = await Promise.all([
    fetchStats(),
    fetchPriority(),
    fetchTrend(),
  ]);
  const trendOk = trend?.source === "clickhouse" && trend.incidentTrend.length > 0;
  const trendTotal = trend?.incidentTrend.reduce((a, p) => a + p.count, 0) ?? 0;

  const activeTotal = stats?.activeTotal ?? 0;
  const sev = (n: number) => stats?.bySeverity[String(n)] ?? 0;
  const byRegion = stats?.byRegion ?? [];
  const byType = stats?.byType ?? [];
  const apiOk = stats !== null;

  const alertLabel =
    sev(1) > 0 ? "CRITICAL" : sev(2) > 0 ? "ELEVATED ALERT" : "NOMINAL";
  const alertChip = sev(1) > 0 ? 1 : sev(2) > 0 ? 2 : 3;

  return (
    <AppShell
      active="dashboard"
      crumbs={["Dashboard", "National Overview"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations Lead" }}
    >
      {/* Hero alert ribbon — real active-incident counts */}
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{copy.statusLocation}</div>
          <div className="flex items-center gap-2.5">
            <span
              className="cmc-display text-[22px] font-semibold"
              style={{ letterSpacing: "-0.01em" }}
            >
              {alertLabel}
            </span>
            <span className={`cmc-chip cmc-chip-sev${alertChip} h-5.5`}>
              SEV-{alertChip}
            </span>
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {activeTotal} active incident{activeTotal === 1 ? "" : "s"} ·{" "}
            {sev(1)} SEV-1 · {sev(2)} SEV-2 · {byRegion.length} region(s) affected
            {!apiOk && " · (incident data unavailable)"}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex gap-2">
          <button className="cmc-btn">
            All Regions
            <ChevronDown size={11} strokeWidth={1.6} />
          </button>
          <Link href="/incidents" className="cmc-btn cmc-btn-primary">
            View incidents
          </Link>
        </div>
      </div>

      {/* KPI strip — derived from /incidents/stats */}
      <div className="grid grid-cols-2 gap-2.5 px-5 pb-1.5 pt-3.5 md:grid-cols-3 lg:grid-cols-6">
        <KPI label="Active Incidents" value={String(activeTotal)} accent="var(--c-sev-2)" />
        <KPI label="SEV-1 Open" value={String(sev(1))} accent="var(--c-sev-1)" />
        <KPI label="SEV-2 Open" value={String(sev(2))} accent="var(--c-sev-2)" />
        <KPI label="SEV-3 Open" value={String(sev(3))} accent="var(--c-sev-3)" />
        <KPI label="Regions Affected" value={String(byRegion.length)} accent="var(--c-info)" />
        <KPI label="Incident Types" value={String(byType.length)} accent="var(--c-ok)" />
      </div>

      {/* Incident trend — ClickHouse-backed historical series (P2.6 / ADR-0036) */}
      <div className="px-5 pt-2.5">
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Incident Trend · 14d</span>
            <div className="flex-1" />
            <span
              className="cmc-mono text-[10.5px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              {trendOk ? `${trendTotal} reported` : "analytics unavailable"}
            </span>
          </div>
          <div className="p-3">
            {trendOk ? (
              <TrendChart data={trend!.incidentTrend} />
            ) : (
              <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
                Trend analytics unavailable.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-3 p-5 pt-2.5 lg:grid-cols-3">
        {/* Incidents by region */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Active by Region</span>
          </div>
          <div className="flex flex-col gap-2 p-3">
            {byRegion.length === 0 ? (
              <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
                No active incidents.
              </div>
            ) : (
              byRegion.map((r, i) => {
                const pct =
                  activeTotal > 0 ? Math.round((r.count / activeTotal) * 100) : 0;
                return (
                  <div key={r.region}>
                    <div className="mb-1 flex items-center justify-between text-[11px]">
                      <span>{r.region}</span>
                      <span className="cmc-mono" style={{ color: "var(--c-fg-3)" }}>
                        {r.count} · {pct}%
                      </span>
                    </div>
                    <PercentBar
                      value={pct}
                      color={BAR_COLORS[i % BAR_COLORS.length]}
                      height={4}
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Incidents by type */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Active by Type</span>
          </div>
          <div className="flex flex-col gap-1.5 p-3 text-[11px]">
            {byType.length === 0 ? (
              <div style={{ color: "var(--c-fg-4)" }}>No active incidents.</div>
            ) : (
              byType.map((t, i) => (
                <div key={t.type} className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-sm"
                    style={{ background: BAR_COLORS[i % BAR_COLORS.length] }}
                  />
                  <span className="flex-1">{t.type}</span>
                  <span className="cmc-mono" style={{ color: "var(--c-fg-3)" }}>
                    {t.count}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Priority incidents — real, most-severe-first */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Priority Incidents</span>
            <div className="flex-1" />
            <Link href="/incidents" className="cmc-btn cmc-btn-ghost text-[10.5px]">
              All →
            </Link>
          </div>
          <div className="flex flex-col">
            {priority.length === 0 ? (
              <div className="p-3 text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
                No active incidents.
              </div>
            ) : (
              priority.map((p, i) => (
                <Link
                  key={p.id}
                  href={`/incidents/${p.id}`}
                  className="flex items-start gap-2.5 px-3 py-2.5 text-[11.5px]"
                  style={{
                    borderBottom:
                      i < priority.length - 1
                        ? "0.5px solid var(--c-line-1)"
                        : undefined,
                  }}
                >
                  <SeverityBadge severity={p.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate" style={{ color: "var(--c-fg-1)" }}>
                      {p.summary}
                    </div>
                    <div
                      className="cmc-mono mt-0.5 text-[10.5px]"
                      style={{ color: "var(--c-fg-3)" }}
                    >
                      {fmt(p.occurredAt)} · {p.region} · {p.type}
                      {p.source ? ` · ${p.source}` : ""}
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
