import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  AuditLogListResponseSchema,
  type AuditLogEntry,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { FormattedDate } from "@/components/cmc/formatted-date";
import { AuditFilters } from "./audit-filters";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("audit");
  return { title: t("metaTitle") };
}

type SearchParams = Record<string, string | string[] | undefined>;

type LogFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

const ONE = (v: string | string[] | undefined): string =>
  (typeof v === "string" ? v : "").trim();

async function fetchLog(
  qs: string,
): Promise<
  { ok: true; data: { entries: AuditLogEntry[]; nextCursor: number | null } }
  | LogFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>(`/audit/log?${qs}`);
    const parsed = AuditLogListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

function outcomeStyle(outcome: string): { color: string; background: string } {
  switch (outcome) {
    case "failure":
      return { color: "var(--c-sev-1)", background: "var(--c-sev-1-soft)" };
    case "denied":
      return { color: "var(--c-sev-2)", background: "var(--c-sev-2-soft)" };
    default:
      return { color: "var(--c-accent)", background: "var(--c-accent-soft)" };
  }
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("audit");
  const tc = await getTranslations("common");
  const access = await getMyAccess();
  const canAudit = hasPermission(access, "audit:read");

  const action = ONE(sp.action);
  const resourceType = ONE(sp.resourceType);
  const outcome = ONE(sp.outcome);
  const before = ONE(sp.before);

  const params = new URLSearchParams();
  if (action) params.set("action", action);
  if (resourceType) params.set("resourceType", resourceType);
  if (outcome) params.set("outcome", outcome);
  if (before) params.set("before", before);
  params.set("limit", "50");

  const result = canAudit ? await fetchLog(params.toString()) : null;

  // "Older" link keeps the active filters, swaps the cursor.
  const olderParams = new URLSearchParams();
  if (action) olderParams.set("action", action);
  if (resourceType) olderParams.set("resourceType", resourceType);
  if (outcome) olderParams.set("outcome", outcome);
  if (result?.ok && result.data.nextCursor != null) {
    olderParams.set("before", String(result.data.nextCursor));
  }

  return (
    <AppShell
      active="audit"
      crumbs={[t("crumbSystem"), t("crumbAudit")]}
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
        {!canAudit ? (
          <div
            className="cmc-card p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {t("noAccess")}
          </div>
        ) : (
          <>
            <div className="cmc-card p-3">
              <AuditFilters />
            </div>

            {result && !result.ok ? (
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
            ) : result?.ok && result.data.entries.length === 0 ? (
              <div
                className="cmc-card p-6 text-center text-[12px]"
                style={{ color: "var(--c-fg-3)" }}
              >
                {t("empty")}
              </div>
            ) : result?.ok ? (
              <div className="cmc-card overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr style={{ color: "var(--c-fg-3)" }}>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thTime")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thAction")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thResource")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thActor")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thOutcome")}
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t("thSealed")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.entries.map((e) => {
                      const os = outcomeStyle(e.outcome);
                      return (
                        <tr
                          key={e.id}
                          style={{ borderTop: "0.5px solid var(--c-line-1)" }}
                        >
                          <td
                            className="cmc-mono whitespace-nowrap px-3 py-2"
                            style={{ color: "var(--c-fg-3)" }}
                          >
                            <FormattedDate value={e.occurredAt} />
                          </td>
                          <td
                            className="px-3 py-2"
                            style={{ color: "var(--c-fg-1)" }}
                          >
                            {e.action}
                          </td>
                          <td
                            className="cmc-mono px-3 py-2"
                            style={{ color: "var(--c-fg-2)" }}
                          >
                            {e.resourceType}
                            {e.resourceId ? `:${e.resourceId}` : ""}
                          </td>
                          <td
                            className="cmc-mono px-3 py-2"
                            style={{ color: "var(--c-fg-3)" }}
                          >
                            {e.actorType}
                            {e.actorId ? ` · ${e.actorId.slice(0, 8)}` : ""}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px]"
                              style={os}
                            >
                              {t(`outcome.${e.outcome}`)}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span
                              style={{
                                color: e.sealed
                                  ? "var(--c-accent)"
                                  : "var(--c-fg-4)",
                              }}
                              title={e.sealed ? t("sealedYes") : t("sealedNo")}
                            >
                              {e.sealed ? "✓" : "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {result?.ok && result.data.nextCursor != null && (
              <div className="flex justify-center">
                <Link
                  href={`/audit?${olderParams.toString()}` as never}
                  className="cmc-btn"
                >
                  {t("older")}
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
