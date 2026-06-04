import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { SwaggerUiClient } from "./swagger-ui-client";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("apiDocs.metaTitle") };
}

const API_PUBLIC_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type LoadResult =
  | { kind: "ok"; spec: Record<string, unknown> }
  | { kind: "disabled" }
  | { kind: "error"; errorKey: "errApiStatus" | "errUnreachable"; status?: number };

/**
 * Fetch the OpenAPI document through the BFF (the bearer is attached
 * server-side). A 404 means the API has `OPENAPI_ENABLED=false`; anything else
 * surfaces as an error panel.
 */
async function loadSpec(): Promise<LoadResult> {
  try {
    const spec = await authedApiFetch<Record<string, unknown>>("/openapi.json");
    // Point "Try it out" at the browser-reachable API origin. The doc's paths
    // already carry `/v1`, so the server URL is the bare origin (no prefix).
    spec.servers = [{ url: API_PUBLIC_BASE, description: "CMC API" }];
    return { kind: "ok", spec };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: "disabled" };
    return err instanceof ApiError
      ? { kind: "error", errorKey: "errApiStatus", status: err.status }
      : { kind: "error", errorKey: "errUnreachable" };
  }
}

export default async function ApiDocsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  const access = await getMyAccess();
  const allowed = hasPermission(access, "tenant:manage");

  const result = allowed ? await loadSpec() : null;

  return (
    <AppShell
      active="admin"
      crumbs={[t("crumbAdministration"), t("crumbApiReference")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleAdmin") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("apiDocs.kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("apiDocs.title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {t("apiDocs.subtitlePre")}
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              /v1
            </span>
            {t("apiDocs.subtitleMid")}{" "}
            <a
              className="cmc-mono"
              href={`${API_PUBLIC_BASE}/v1/openapi.json`}
              style={{ color: "var(--c-accent)" }}
            >
              openapi.json
            </a>
          </div>
        </div>
      </div>

      <div className="p-5">
        {!allowed ? (
          <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
            {t("apiDocs.needPermissionPre")}{" "}
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              tenant:manage
            </span>
            {t("apiDocs.needPermissionPost")}
          </div>
        ) : result?.kind === "disabled" ? (
          <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
            {t("apiDocs.disabledPre")}
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              OPENAPI_ENABLED=false
            </span>
            {t("apiDocs.disabledPost")}
          </div>
        ) : result?.kind === "error" ? (
          <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-sev1)" }}>
            {result.errorKey === "errApiStatus"
              ? t("apiDocs.errApiStatus", { status: result.status ?? 0 })
              : t("apiDocs.errUnreachable")}
          </div>
        ) : result?.kind === "ok" ? (
          <SwaggerUiClient spec={result.spec} />
        ) : null}
      </div>
    </AppShell>
  );
}
