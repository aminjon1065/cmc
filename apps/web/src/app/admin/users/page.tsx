import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
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
import { fetchRegions } from "@/lib/regions";
import { CreateUserForm } from "./create-user-form";
import { UserRow } from "./user-row";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("users.metaTitle") };
}

type RoleRef = { id: string; slug: string; name: string; isSystem: boolean };

type UsersFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errLoad";
  status?: number;
};

async function fetchUsers(): Promise<
  { ok: true; users: UserSummary[] } | UsersFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/users");
    const parsed = UsersListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, users: parsed.data.users };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
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
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  const access = await getMyAccess();
  const [result, roles, regions] = await Promise.all([
    fetchUsers(),
    fetchRoles(),
    fetchRegions(),
  ]);

  return (
    <AppShell
      active="admin"
      crumbs={[t("crumbAdministration"), t("crumbUsers")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleAdmin") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("users.kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("users.title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {result.ok
              ? t("users.subtitle", { count: result.users.length })
              : tc("dash")}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {/* Create */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("users.inviteSection")}</span>
          </div>
          <div className="p-4">
            <CreateUserForm roles={roles} />
            <p className="mt-2 text-[11px]" style={{ color: "var(--c-fg-4)" }}>
              {t("users.inviteHint")}
            </p>
          </div>
        </div>

        {/* List */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("users.allUsers")}</span>
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
              {result.errorKey === "errApi"
                ? t("users.errApi", { status: result.status ?? 0 })
                : t(`users.${result.errorKey}`)}
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
                    <th className="px-4 py-2 font-medium">{t("users.thUser")}</th>
                    <th className="px-4 py-2 font-medium">{t("users.thRoles")}</th>
                    <th className="px-4 py-2 font-medium">{t("users.thRegion")}</th>
                    <th className="px-4 py-2 font-medium">{t("users.thStatus")}</th>
                    <th className="px-4 py-2 font-medium">
                      {t("users.thLastLogin")}
                    </th>
                    <th className="px-4 py-2 font-medium">
                      {t("users.thActions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.users.map((u) => (
                    <UserRow
                      key={u.id}
                      user={u}
                      roles={roles}
                      regions={regions}
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
