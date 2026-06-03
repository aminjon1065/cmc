import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  MonitoringSummaryResponseSchema,
  type MonitoringSummary,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { MonitoringWall } from "./monitoring-wall";
import { ReplayPanel } from "./replay-panel";

export const metadata: Metadata = { title: "Command Center" };

async function fetchSummary(): Promise<
  { ok: true; summary: MonitoringSummary } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/monitoring/summary");
    const parsed = MonitoringSummaryResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, summary: parsed.data.summary };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view the monitoring center."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load the monitoring center." };
  }
}

export default async function MonitoringPage() {
  const session = await auth();
  const { copy } = await getBranding();
  // Gating is enforced by the API (monitoring:read → 403); the page renders the
  // result (wall or the permission error).
  const result = await fetchSummary();

  return (
    <AppShell
      active="command"
      crumbs={["Operations", "Command Center"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      {!result.ok ? (
        <div className="p-5">
          <div className="cmc-card">
            <div
              className="m-4 rounded-md p-3 text-[12px]"
              style={{
                color: "var(--c-sev-1)",
                background: "var(--c-sev-1-soft)",
                border:
                  "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              {result.error}
            </div>
          </div>
        </div>
      ) : (
        <>
          <MonitoringWall initialSummary={result.summary} />
          <div className="px-5 pb-5">
            <ReplayPanel />
          </div>
        </>
      )}
    </AppShell>
  );
}
