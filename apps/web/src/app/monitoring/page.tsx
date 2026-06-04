import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  MonitoringSummaryResponseSchema,
  type MonitoringSummary,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { MonitoringWall } from "./monitoring-wall";
import { ReplayPanel } from "./replay-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("monitoring");
  return { title: t("metaTitle") };
}

type SummaryFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchSummary(): Promise<
  { ok: true; summary: MonitoringSummary } | SummaryFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/monitoring/summary");
    const parsed = MonitoringSummaryResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, summary: parsed.data.summary };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function MonitoringPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("monitoring");
  const tc = await getTranslations("common");
  // Gating is enforced by the API (monitoring:read → 403); the page renders the
  // result (wall or the permission error).
  const result = await fetchSummary();

  return (
    <AppShell
      active="command"
      crumbs={[t("crumbOps"), t("crumbCommandCenter")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
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
              {result.errorKey === "errApi"
                ? t("errApi", { status: result.status ?? 0 })
                : t(result.errorKey)}
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
