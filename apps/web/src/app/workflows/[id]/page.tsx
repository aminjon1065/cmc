import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { WorkflowResponseSchema, type Workflow } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { WorkflowEditor } from "./workflow-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("workflows");
  return { title: t("metaTitleEditor") };
}

async function fetchWorkflow(id: string): Promise<Workflow | null> {
  try {
    const raw = await authedApiFetch<unknown>(`/workflows/${id}`);
    const parsed = WorkflowResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.workflow : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export default async function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("workflows");
  const tc = await getTranslations("common");
  const workflow = await fetchWorkflow(id);
  if (!workflow) notFound();

  return (
    <AppShell
      active="workflow"
      crumbs={[t("crumbWork"), t("crumbWorkflows"), workflow.name]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
    >
      <div
        className="flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <Link
          href="/workflows"
          className="text-[12px] hover:underline"
          style={{ color: "var(--c-fg-3)" }}
        >
          {t("backToWorkflows")}
        </Link>
        <span className="text-[12px]" style={{ color: "var(--c-fg-4)" }}>
          /
        </span>
        <span
          className="cmc-display text-[15px] font-semibold"
          style={{ color: "var(--c-fg-1)" }}
        >
          {workflow.name}
        </span>
      </div>

      <WorkflowEditor initial={workflow} />
    </AppShell>
  );
}
