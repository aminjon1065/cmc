import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  WikiSpacesListResponseSchema,
  type WikiSpace,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { NewSpaceButton } from "./new-space-button";

export const metadata: Metadata = { title: "Knowledge Base" };

async function fetchSpaces(): Promise<
  { ok: true; spaces: WikiSpace[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/wiki/spaces");
    const parsed = WikiSpacesListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, spaces: parsed.data.spaces };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view the knowledge base."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load spaces." };
  }
}

export default async function WikiPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access] = await Promise.all([fetchSpaces(), getMyAccess()]);
  const canManage = hasPermission(access, "wiki:manage");

  return (
    <AppShell
      active="wiki"
      crumbs={["Knowledge", "Knowledge Base"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Knowledge · Wiki</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Knowledge Base
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Spaces hold a tree of pages — rich text, versioned on every save.
          </div>
        </div>
        <div className="flex-1" />
        {canManage && <NewSpaceButton />}
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
        ) : result.spaces.length === 0 ? (
          <div className="cmc-card">
            <div
              className="p-6 text-center text-[12px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              No spaces yet.
              {canManage
                ? " Create one to start writing."
                : " Ask an administrator to create one."}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {result.spaces.map((s) => (
              <Link key={s.id} href={`/wiki/${s.id}`} className="cmc-card block p-4">
                <div
                  className="cmc-display text-[14px] font-semibold"
                  style={{ color: "var(--c-fg-1)" }}
                >
                  {s.name}
                </div>
                <div
                  className="mt-1 line-clamp-2 text-[11.5px]"
                  style={{ color: "var(--c-fg-3)", minHeight: 30 }}
                >
                  {s.description || "No description."}
                </div>
                <div
                  className="cmc-mono mt-2 text-[10px]"
                  style={{ color: "var(--c-fg-4)" }}
                >
                  updated {new Date(s.updatedAt).toLocaleDateString()}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
