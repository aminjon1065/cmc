import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  DashboardAnalyticsResponseSchema,
  type DashboardAnalyticsResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { TrendChart } from "@/components/cmc/trend-chart";

const WINDOW_DAYS = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("analytics");
  return { title: t("metaTitle") };
}

type LoadResult =
  | { ok: true; trend: DashboardAnalyticsResponse }
  | { ok: false; errorKey: "errShape" | "errApi" | "errLoad"; status?: number };

async function load(): Promise<LoadResult> {
  try {
    const d = await authedApiFetch<unknown>(
      `/analytics/dashboard?days=${WINDOW_DAYS}`,
    );
    const trend = DashboardAnalyticsResponseSchema.safeParse(d);
    if (!trend.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, trend: trend.data };
  } catch (err) {
    if (err instanceof ApiError)
      return { ok: false, errorKey: "errApi", status: err.status };
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function AnalyticsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("analytics");
  const tc = await getTranslations("common");
  const access = await getMyAccess();
  const canView = hasPermission(access, "incident:read");

  const result = canView ? await load() : null;

  return (
    <AppShell
      active="analytics"
      crumbs={[t("crumbIntel"), t("crumbAnalytics")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {t("subtitle")}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {!canView ? (
          <div
            className="cmc-card p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {t("noAccess")}
          </div>
        ) : result && !result.ok ? (
          <div
            className="rounded-md p-3 text-[12px]"
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
        ) : result?.ok ? (
          <div className="cmc-card">
            <div className="cmc-card-header flex items-center">
              <span className="cmc-label">{t("trendTitle")}</span>
              <div className="flex-1" />
              <span
                className="cmc-mono text-[10.5px]"
                style={{ color: "var(--c-fg-3)" }}
              >
                {t("trendWindow", { days: result.trend.windowDays })}
              </span>
            </div>
            <div className="p-4">
              <TrendChart data={result.trend.incidentTrend} height={72} />
              <div
                className="mt-2 text-[11px]"
                style={{ color: "var(--c-fg-3)" }}
              >
                {t("trendTotal", {
                  count: result.trend.incidentTrend.reduce(
                    (s, p) => s + p.count,
                    0,
                  ),
                })}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
