import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  RolesListResponseSchema,
  PermissionCatalogResponseSchema,
  type PermissionCatalogEntry,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { CreateRoleForm } from "./create-role-form";
import { RoleCard } from "./role-card";

export const metadata: Metadata = { title: "Roles · Administration" };

type Role = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
};

async function fetchRoles(): Promise<
  { ok: true; roles: Role[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/rbac/roles");
    const parsed = RolesListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, roles: parsed.data.roles };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: `API ${err.status}` };
    return { ok: false, error: "Failed to load roles." };
  }
}

async function fetchCatalog(): Promise<PermissionCatalogEntry[]> {
  try {
    const raw = await authedApiFetch<unknown>("/rbac/permissions");
    const parsed = PermissionCatalogResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.permissions : [];
  } catch {
    return [];
  }
}

export default async function AdminRolesPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, catalog] = await Promise.all([fetchRoles(), fetchCatalog()]);

  const system = result.ok ? result.roles.filter((r) => r.isSystem) : [];
  const custom = result.ok ? result.roles.filter((r) => !r.isSystem) : [];

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "Roles"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration · Roles</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Roles &amp; Permissions
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            System roles are immutable. Build custom roles from the permission
            catalog.
          </div>
        </div>
      </div>

      {!result.ok ? (
        <div
          className="m-5 rounded-md p-3 text-[12px]"
          style={{
            color: "var(--c-sev-1)",
            background: "var(--c-sev-1-soft)",
            border:
              "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
          }}
        >
          {result.error}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-5">
          {/* Create */}
          <div className="cmc-card">
            <div className="cmc-card-header">
              <span className="cmc-label">Custom roles</span>
            </div>
            <div className="flex flex-col gap-4 p-4">
              <CreateRoleForm catalog={catalog} />
              {custom.length === 0 ? (
                <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
                  No custom roles yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {custom.map((r) => (
                    <RoleCard key={r.id} role={r} catalog={catalog} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* System roles (read-only) */}
          <div>
            <div className="cmc-label mb-2 px-1">System roles</div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {system.map((r) => (
                <RoleCard key={r.id} role={r} catalog={catalog} />
              ))}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
