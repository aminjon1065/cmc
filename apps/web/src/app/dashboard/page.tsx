import type { Metadata } from "next";
import { ChevronDown } from "lucide-react";
import { auth } from "@/auth";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { type MeResponse, MeResponseSchema } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { KPI } from "@/components/cmc/kpi";
import { PercentBar } from "@/components/cmc/percent-bar";

export const metadata: Metadata = {
  title: "Dashboard",
};

async function fetchMe(): Promise<
  { ok: true; data: MeResponse } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/auth/me");
    const parsed = MeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "API returned an unexpected shape" };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: `API ${err.status}: ${err.message}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

const REGIONS = [
  { name: "Khatlon", count: 9, pct: 33, color: "var(--c-sev-1)" },
  { name: "GBAO", count: 7, pct: 26, color: "var(--c-sev-2)" },
  { name: "Sughd", count: 5, pct: 19, color: "var(--c-sev-3)" },
  { name: "DRS", count: 4, pct: 15, color: "var(--c-info)" },
  { name: "Dushanbe", count: 2, pct: 7, color: "var(--c-ok)" },
];

const INCIDENT_TYPES = [
  { name: "Flood", count: 8, color: "var(--c-info)" },
  { name: "Mudflow", count: 6, color: "#d97757" },
  { name: "Earthquake", count: 5, color: "var(--c-sev-2)" },
  { name: "Landslide", count: 4, color: "var(--c-violet)" },
  { name: "Wildfire", count: 4, color: "var(--c-ok)" },
];

const PRIORITY = [
  {
    time: "03:42",
    sev: 1,
    region: "Khatlon",
    type: "Flood",
    text: "Vakhsh river breach",
    source: "MNS",
    fresh: true,
  },
  {
    time: "03:31",
    sev: 2,
    region: "GBAO",
    type: "Mudflow",
    text: "M41 km 412 blocked",
    source: "DOR",
  },
  {
    time: "03:18",
    sev: 2,
    region: "Sughd",
    type: "Earthquake",
    text: "M4.2 Shahriston",
    source: "IGS",
  },
];

export default async function DashboardPage() {
  const session = await auth();
  const me = await fetchMe();

  return (
    <AppShell
      active="dashboard"
      crumbs={["Dashboard", "National Overview"]}
      tenant={session?.tenantSlug}
      user={{
        name:
          session?.user?.name ??
          (me.ok ? me.data.user.name : null),
        role: "Operations Lead · L4",
      }}
    >
      {/* Hero alert ribbon */}
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">
            National Operational Status · Dushanbe
          </div>
          <div className="flex items-center gap-2.5">
            <span
              className="cmc-display text-[22px] font-semibold"
              style={{ letterSpacing: "-0.01em" }}
            >
              ELEVATED ALERT · Flood Watch
            </span>
            <span className="cmc-chip cmc-chip-sev2 h-5.5">SEV-2</span>
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            4 active SEV-2 incidents · 27 total active · 2 487 evacuated ·
            Cabinet briefed at 03:15
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex gap-2">
          <button className="cmc-btn">
            14 May 2026
            <ChevronDown size={11} strokeWidth={1.6} />
          </button>
          <button className="cmc-btn">
            All Regions
            <ChevronDown size={11} strokeWidth={1.6} />
          </button>
          <button className="cmc-btn cmc-btn-primary">Brief Cabinet</button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 px-5 pb-1.5 pt-3.5 md:grid-cols-3 lg:grid-cols-6">
        <KPI
          label="Active Incidents"
          value="27"
          delta="+5 24h"
          trend="up"
          accent="var(--c-sev-2)"
          sparkData={[18, 20, 22, 21, 24, 26, 27]}
        />
        <KPI
          label="SEV-1 Open"
          value="3"
          delta="+2"
          trend="up"
          accent="var(--c-sev-1)"
          sparkData={[1, 1, 2, 2, 3, 3, 3]}
        />
        <KPI
          label="Evacuated"
          value="2,487"
          delta="+412 4h"
          trend="up"
          accent="var(--c-info)"
          sparkData={[100, 400, 800, 1200, 1800, 2200, 2487]}
        />
        <KPI
          label="Crews Deployed"
          value="14/18"
          delta="+2 enroute"
          accent="var(--c-ok)"
          sparkData={[11, 12, 12, 13, 14, 14, 14]}
        />
        <KPI
          label="Cases Open"
          value="142"
          delta="-8 today"
          trend="down"
          sparkData={[150, 148, 146, 144, 143, 144, 142]}
        />
        <KPI
          label="MTTR · 7d"
          value="2.4h"
          delta="-23 min"
          trend="down"
          accent="var(--c-ok)"
          sparkData={[3.2, 3.0, 2.8, 2.7, 2.6, 2.5, 2.4]}
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-3 p-5 pt-2.5 lg:grid-cols-3">
        {/* Incidents by region */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Incidents by Region</span>
          </div>
          <div className="flex flex-col gap-2 p-3">
            {REGIONS.map((r) => (
              <div key={r.name}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span>{r.name}</span>
                  <span
                    className="cmc-mono"
                    style={{ color: "var(--c-fg-3)" }}
                  >
                    {r.count} · {r.pct}%
                  </span>
                </div>
                <PercentBar value={r.pct} color={r.color} height={4} />
              </div>
            ))}
          </div>
        </div>

        {/* Incidents by type */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">By Incident Type</span>
          </div>
          <div className="flex flex-col gap-1.5 p-3 text-[11px]">
            {INCIDENT_TYPES.map((t) => (
              <div key={t.name} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ background: t.color }}
                />
                <span className="flex-1">{t.name}</span>
                <span
                  className="cmc-mono"
                  style={{ color: "var(--c-fg-3)" }}
                >
                  {t.count}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Priority incidents */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Priority Incidents</span>
            <div className="flex-1" />
            <button className="cmc-btn cmc-btn-ghost text-[10.5px]">
              All →
            </button>
          </div>
          <div className="flex flex-col">
            {PRIORITY.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 px-3 py-2.5 text-[11.5px]"
                style={{
                  borderBottom:
                    i < PRIORITY.length - 1
                      ? "0.5px solid var(--c-line-1)"
                      : undefined,
                }}
              >
                <span
                  className={`cmc-chip cmc-chip-sev${p.sev}`}
                  style={{ minWidth: 38, justifyContent: "center" }}
                >
                  SEV-{p.sev}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span style={{ color: "var(--c-fg-1)" }}>{p.text}</span>
                    {p.fresh && (
                      <span
                        className="cmc-dot cmc-dot-pulse"
                        style={{
                          background: "var(--c-sev-1)",
                          color: "var(--c-sev-1)",
                        }}
                      />
                    )}
                  </div>
                  <div
                    className="cmc-mono mt-0.5 text-[10.5px]"
                    style={{ color: "var(--c-fg-3)" }}
                  >
                    {p.time} · {p.region} · {p.type} · {p.source}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* /auth/me — real session payload */}
        <div className="cmc-card lg:col-span-3">
          <div className="cmc-card-header">
            <span className="cmc-label">Session · /auth/me</span>
            <div className="flex-1" />
            <span
              className="cmc-chip"
              style={{
                color: me.ok ? "var(--c-ok)" : "var(--c-sev-1)",
                background: me.ok ? "var(--c-ok-soft)" : "var(--c-sev-1-soft)",
                borderColor: me.ok
                  ? "color-mix(in srgb, var(--c-ok) 30%, transparent)"
                  : "color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              {me.ok ? "200 OK" : "Failed"}
            </span>
          </div>
          {me.ok ? (
            <pre
              className="cmc-mono overflow-x-auto p-3 text-[11px]"
              style={{ color: "var(--c-fg-2)" }}
            >
              {JSON.stringify(me.data, null, 2)}
            </pre>
          ) : (
            <div
              className="m-3 rounded-md p-3 text-[12px]"
              style={{
                color: "var(--c-sev-1)",
                background: "var(--c-sev-1-soft)",
                border:
                  "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              {me.error}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
