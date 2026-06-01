import type { Metadata } from "next";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { SwaggerUiClient } from "./swagger-ui-client";

export const metadata: Metadata = {
  title: "API Reference",
};

const API_PUBLIC_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type LoadResult =
  | { kind: "ok"; spec: Record<string, unknown> }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

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
    const message =
      err instanceof ApiError
        ? `API returned ${err.status}.`
        : "Could not reach the API.";
    return { kind: "error", message };
  }
}

export default async function ApiDocsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const access = await getMyAccess();
  const allowed = hasPermission(access, "tenant:manage");

  const result = allowed ? await loadSpec() : null;

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "API Reference"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            API Reference
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            The versioned REST API ({" "}
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              /v1
            </span>
            ), generated from the live contracts ·{" "}
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
            You need the{" "}
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              tenant:manage
            </span>{" "}
            permission to view the API reference.
          </div>
        ) : result?.kind === "disabled" ? (
          <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
            The OpenAPI document is disabled on this environment (
            <span className="cmc-mono" style={{ color: "var(--c-fg-2)" }}>
              OPENAPI_ENABLED=false
            </span>
            ).
          </div>
        ) : result?.kind === "error" ? (
          <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-sev1)" }}>
            {result.message}
          </div>
        ) : result?.kind === "ok" ? (
          <SwaggerUiClient spec={result.spec} />
        ) : null}
      </div>
    </AppShell>
  );
}
