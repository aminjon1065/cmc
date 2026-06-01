import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  UsersListResponseSchema,
  RolesListResponseSchema,
  type UserSummary,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { CreateUserForm } from "./create-user-form";
import { UserRow } from "./user-row";

export const metadata: Metadata = { title: "Users · Administration" };

type RoleRef = { id: string; slug: string; name: string; isSystem: boolean };

async function fetchUsers(): Promise<
  { ok: true; users: UserSummary[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/users");
    const parsed = UsersListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, users: parsed.data.users };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: `API ${err.status}` };
    }
    return { ok: false, error: "Failed to load users." };
  }
}

async function fetchRoles(): Promise<RoleRef[]> {
  try {
    const raw = await authedApiFetch<unknown>("/rbac/roles");
    const parsed = RolesListResponseSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.roles.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      isSystem: r.isSystem,
    }));
  } catch {
    return [];
  }
}

export default async function AdminUsersPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const access = await getMyAccess();
  const [result, roles] = await Promise.all([fetchUsers(), fetchRoles()]);

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "Users"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration · Users</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Users
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {result.ok ? `${result.users.length} user(s)` : "—"} ·{" "}
            invite, deactivate, and assign roles.
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {/* Create */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Invite a user</span>
          </div>
          <div className="p-4">
            <CreateUserForm roles={roles} />
            <p className="mt-2 text-[11px]" style={{ color: "var(--c-fg-4)" }}>
              New users have no password until you send a reset link (no email
              channel yet — you relay the token).
            </p>
          </div>
        </div>

        {/* List */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">All users</span>
          </div>
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
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr
                    className="text-left"
                    style={{
                      color: "var(--c-fg-4)",
                      borderBottom: "0.5px solid var(--c-line-2)",
                    }}
                  >
                    <th className="px-4 py-2 font-medium">User</th>
                    <th className="px-4 py-2 font-medium">Roles</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Last login</th>
                    <th className="px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {result.users.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      roles={roles}
                      isSelf={u.id === access?.userId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
