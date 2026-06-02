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
import { NewWorkflowButton } from "./new-workflow-button";

export const metadata: Metadata = { title: "Workflows" };

async function fetchWorkflows(): Promise<
  { ok: true; workflows: Workflow[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/workflows");
    const parsed = WorkflowsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, workflows: parsed.data.workflows };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view workflows."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load workflows." };
  }
}

export default async function WorkflowsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const result = await fetchWorkflows();

  return (
    <AppShell
      active="workflow"
      crumbs={["Work", "Workflows"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Work · Workflows</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Workflows
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Visual automations — build a graph, run it on Temporal.
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
              {result.error}
            </div>
          ) : result.workflows.length === 0 ? (
            <div
              className="p-6 text-center text-[12px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              No workflows yet. Create one to get started.
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
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Trigger</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Nodes</th>
                  <th className="px-4 py-2 font-medium">Version</th>
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
                        ? `event · ${w.trigger.event ?? "—"}`
                        : "manual"}
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
                        {w.enabled ? "enabled" : "draft"}
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
