import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  AnomaliesResponseSchema,
  DashboardAnalyticsResponseSchema,
  type AnomaliesResponse,
  type DashboardAnalyticsResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { TrendChart } from "@/components/cmc/trend-chart";
import { FormattedDate } from "@/components/cmc/formatted-date";

const WINDOW_DAYS = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("analytics");
  return { title: t("metaTitle") };
}

type LoadResult =
  | {
      ok: true;
      trend: DashboardAnalyticsResponse;
      anomalies: AnomaliesResponse;
    }
  | { ok: false; errorKey: "errShape" | "errApi" | "errLoad"; status?: number };

async function load(): Promise<LoadResult> {
  try {
    const [d, a] = await Promise.all([
      authedApiFetch<unknown>(`/analytics/dashboard?days=${WINDOW_DAYS}`),
      authedApiFetch<unknown>(`/analytics/anomalies?days=${WINDOW_DAYS}`),
    ]);
    const trend = DashboardAnalyticsResponseSchema.safeParse(d);
    const anomalies = AnomaliesResponseSchema.safeParse(a);
    if (!trend.success || !anomalies.success)
      return { ok: false, errorKey: "errShape" };
    return { ok: true, trend: trend.data, anomalies: anomalies.data };
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
          <>
            {/* Incident trend */}
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
                {result.trend.source === "unavailable" ? (
                  <div className="text-[12px]" style={{ color: "var(--c-fg-3)" }}>
                    {t("unavailable")}
                  </div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>

            {/* Anomalies */}
            <div className="cmc-card">
              <div className="cmc-card-header flex items-center">
                <span className="cmc-label">{t("anomaliesTitle")}</span>
                <div className="flex-1" />
                {result.anomalies.source === "clickhouse" && (
                  <span
                    className="cmc-mono text-[10.5px]"
                    style={{ color: "var(--c-fg-3)" }}
                  >
                    {t("anomaliesSummary", {
                      count: result.anomalies.anomalies.length,
                      z: result.anomalies.zThreshold,
                    })}
                  </span>
                )}
              </div>
              {result.anomalies.source === "unavailable" ? (
                <div
                  className="p-4 text-[12px]"
                  style={{ color: "var(--c-fg-3)" }}
                >
                  {t("unavailable")}
                </div>
              ) : result.anomalies.anomalies.length === 0 ? (
                <div
                  className="p-4 text-[12px]"
                  style={{ color: "var(--c-fg-3)" }}
                >
                  {t("noAnomalies")}
                </div>
              ) : (
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr style={{ color: "var(--c-fg-3)" }}>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thDay")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thCount")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thExpected")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thZ")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thDirection")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.anomalies.anomalies.map((a) => (
                      <tr
                        key={a.day}
                        style={{ borderTop: "0.5px solid var(--c-line-1)" }}
                      >
                        <td
                          className="cmc-mono whitespace-nowrap px-3 py-2"
                          style={{ color: "var(--c-fg-2)" }}
                        >
                          <FormattedDate value={a.day} preset="date" />
                        </td>
                        <td
                          className="cmc-mono px-3 py-2"
                          style={{ color: "var(--c-fg-1)" }}
                        >
                          {a.count}
                        </td>
                        <td
                          className="cmc-mono px-3 py-2"
                          style={{ color: "var(--c-fg-3)" }}
                        >
                          {a.mean.toFixed(1)} ± {a.stddev.toFixed(1)}
                        </td>
                        <td
                          className="cmc-mono px-3 py-2"
                          style={{ color: "var(--c-fg-2)" }}
                        >
                          {a.z.toFixed(1)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={
                              a.direction === "spike"
                                ? {
                                    color: "var(--c-sev-1)",
                                    background: "var(--c-sev-1-soft)",
                                  }
                                : {
                                    color: "var(--c-accent)",
                                    background: "var(--c-accent-soft)",
                                  }
                            }
                          >
                            {t(`dir.${a.direction}`)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
