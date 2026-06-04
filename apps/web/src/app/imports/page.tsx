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
import { getTranslations } from "next-intl/server";
import { ImportsManager } from "./imports-manager";
import { listGisLayersAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("imports");
  return { title: t("metaTitle") };
}

type JobsFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchJobs(): Promise<
  { ok: true; jobs: ImportJob[] } | JobsFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/imports");
    const parsed = ImportJobsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, jobs: parsed.data.jobs };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function ImportsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("imports");
  const tc = await getTranslations("common");
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
      crumbs={[t("crumbWork"), t("crumbDataImport")]}
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
              {result.errorKey === "errApi"
                ? t("errApi", { status: result.status ?? 0 })
                : t(result.errorKey)}
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
