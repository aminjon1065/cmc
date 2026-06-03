import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  ImportJobsListResponseSchema,
  type ImportJob,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { ImportsManager } from "./imports-manager";
import { listGisLayersAction } from "./actions";

export const metadata: Metadata = { title: "Data Import" };

async function fetchJobs(): Promise<
  { ok: true; jobs: ImportJob[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/imports");
    const parsed = ImportJobsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, jobs: parsed.data.jobs };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view imports."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load imports." };
  }
}

export default async function ImportsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access, layersRes] = await Promise.all([
    fetchJobs(),
    getMyAccess(),
    listGisLayersAction(),
  ]);
  const canRun = hasPermission(access, "import:run");
  const layers = layersRes.ok ? layersRes.data : [];

  return (
    <AppShell
      active="imports"
      crumbs={["Work", "Data Import"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Work · Import</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Data Import
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Bulk-load CSV / Excel → incidents and GeoJSON / Shapefile → GIS.
            Invalid rows are quarantined, not dropped.
          </div>
        </div>
      </div>

      <div className="p-5">
        {!result.ok ? (
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
        ) : (
          <ImportsManager
            initialJobs={result.jobs}
            canRun={canRun}
            layers={layers}
          />
        )}
      </div>
    </AppShell>
  );
}
