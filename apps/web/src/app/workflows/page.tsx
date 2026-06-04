import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  WorkflowsListResponseSchema,
  type Workflow,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { NewWorkflowButton } from "./new-workflow-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("workflows");
  return { title: t("metaTitle") };
}

type WorkflowsFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchWorkflows(): Promise<
  { ok: true; workflows: Workflow[] } | WorkflowsFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/workflows");
    const parsed = WorkflowsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, workflows: parsed.data.workflows };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function WorkflowsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("workflows");
  const tc = await getTranslations("common");
  const result = await fetchWorkflows();

  return (
    <AppShell
      active="workflow"
      crumbs={[t("crumbWork"), t("crumbWorkflows")]}
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
        <div className="flex-1" />
        <NewWorkflowButton />
      </div>

      <div className="p-5">
        <div className="cmc-card">
          {!result.ok ? (
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
          ) : result.workflows.length === 0 ? (
            <div
              className="p-6 text-center text-[12px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              {t("noWorkflows")}
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr
                  className="text-left"
                  style={{
                    color: "var(--c-fg-4)",
                    borderBottom: "0.5px solid var(--c-line-2)",
                  }}
                >
                  <th className="px-4 py-2 font-medium">{t("thName")}</th>
                  <th className="px-4 py-2 font-medium">{t("thTrigger")}</th>
                  <th className="px-4 py-2 font-medium">{t("thStatus")}</th>
                  <th className="px-4 py-2 font-medium">{t("thNodes")}</th>
                  <th className="px-4 py-2 font-medium">{t("thVersion")}</th>
                </tr>
              </thead>
              <tbody>
                {result.workflows.map((w) => (
                  <tr
                    key={w.id}
                    style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/workflows/${w.id}`}
                        className="hover:underline"
                        style={{ color: "var(--c-fg-1)" }}
                      >
                        {w.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5" style={{ color: "var(--c-fg-2)" }}>
                      {w.trigger.type === "event"
                        ? t("triggerEvent", { event: w.trigger.event ?? "—" })
                        : t("triggerManual")}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className="cmc-mono rounded px-1.5 py-0.5 text-[9.5px] uppercase"
                        style={{
                          color: w.enabled
                            ? "var(--c-accent)"
                            : "var(--c-fg-3)",
                          background: w.enabled
                            ? "color-mix(in srgb, var(--c-accent) 12%, transparent)"
                            : "var(--c-bg-3)",
                        }}
                      >
                        {w.enabled ? t("statusEnabled") : t("statusDraft")}
                      </span>
                    </td>
                    <td className="px-4 py-2.5" style={{ color: "var(--c-fg-3)" }}>
                      {w.definition.nodes.length}
                    </td>
                    <td
                      className="cmc-mono px-4 py-2.5 text-[10.5px]"
                      style={{ color: "var(--c-fg-3)" }}
                    >
                      v{w.version}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  );
}
