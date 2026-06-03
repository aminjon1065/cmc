import type { Metadata } from "next";
import Link from "next/link";
import {
  Building2,
  FileJson2,
  KeyRound,
  MapPin,
  ShieldCheck,
  Users,
} from "lucide-react";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess } from "@/lib/access";

export const metadata: Metadata = {
  title: "Administration",
};

/**
 * Admin sections. `available` flips to true as each phase lands:
 *   Users → P1.4b · Roles → P1.4c · Tenant → P1.4d
 * Until then a section is a non-clickable placeholder so the overview never
 * links to a 404.
 */
const SECTIONS: {
  id: string;
  title: string;
  description: string;
  href: string;
  icon: typeof Users;
  available: boolean;
  phase: string;
}[] = [
  {
    id: "users",
    title: "Users",
    description: "Invite, deactivate, and assign roles to people in this tenant.",
    href: "/admin/users",
    icon: Users,
    available: true,
    phase: "P1.4b",
  },
  {
    id: "roles",
    title: "Roles & Permissions",
    description: "Review system roles and build custom roles from the catalog.",
    href: "/admin/roles",
    icon: ShieldCheck,
    available: true,
    phase: "P1.4c",
  },
  {
    id: "regions",
    title: "Regions",
    description:
      "Manage regions and the per-region visibility of users + operational data.",
    href: "/admin/regions",
    icon: MapPin,
    available: true,
    phase: "P4.6",
  },
  {
    id: "tenant",
    title: "Tenant Settings",
    description: "Edit this tenant's name and branding (logo, copy, theme).",
    href: "/admin/tenant",
    icon: Building2,
    available: true,
    phase: "P1.4d",
  },
  {
    id: "api-docs",
    title: "API Reference",
    description:
      "Browse the versioned REST API (/v1), generated from the live contracts.",
    href: "/admin/api-docs",
    icon: FileJson2,
    available: true,
    phase: "P1.10b",
  },
  {
    id: "api-keys",
    title: "API Keys",
    description:
      "Issue scoped API keys for programmatic access, set quotas, and revoke.",
    href: "/admin/api-keys",
    icon: KeyRound,
    available: true,
    phase: "P3.9",
  },
];

export default async function AdminOverviewPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const access = await getMyAccess();

  return (
    <AppShell
      active="admin"
      crumbs={["Administration"]}
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
            Tenant Administration
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Manage users, roles, and settings for{" "}
            <span style={{ color: "var(--c-fg-2)" }}>
              {session?.tenantSlug ?? "this tenant"}
            </span>
            .
          </div>
        </div>
      </div>

      {/* Section cards */}
      <div className="grid grid-cols-1 gap-3 p-5 pb-2.5 md:grid-cols-3">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const body = (
            <div
              className="cmc-card h-full"
              style={{ opacity: s.available ? 1 : 0.62 }}
            >
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md"
                    style={{ background: "var(--c-bg-3)" }}
                  >
                    <Icon
                      size={15}
                      strokeWidth={1.6}
                      style={{ color: "var(--c-accent)" }}
                    />
                  </span>
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: "var(--c-fg-1)" }}
                  >
                    {s.title}
                  </span>
                  <div className="flex-1" />
                  {!s.available && (
                    <span className="cmc-chip" style={{ color: "var(--c-fg-3)" }}>
                      {s.phase}
                    </span>
                  )}
                </div>
                <div className="text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
                  {s.description}
                </div>
              </div>
            </div>
          );
          return s.available ? (
            <Link key={s.id} href={s.href as never} className="block">
              {body}
            </Link>
          ) : (
            <div
              key={s.id}
              aria-disabled
              title="Coming soon"
              className="cursor-not-allowed"
            >
              {body}
            </div>
          );
        })}
      </div>

      {/* Your access — real data from /rbac/me, proves the gating foundation. */}
      <div className="px-5 pb-5">
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Your access · /rbac/me</span>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div>
              <div
                className="mb-1.5 text-[10.5px] font-semibold uppercase"
                style={{ color: "var(--c-fg-4)", letterSpacing: "0.06em" }}
              >
                Roles
              </div>
              <div className="flex flex-wrap gap-1.5">
                {access && access.roles.length > 0 ? (
                  access.roles.map((r) => (
                    <span key={r.id} className="cmc-chip">
                      {r.name}
                    </span>
                  ))
                ) : (
                  <span className="text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
                    none
                  </span>
                )}
              </div>
            </div>
            <div>
              <div
                className="mb-1.5 text-[10.5px] font-semibold uppercase"
                style={{ color: "var(--c-fg-4)", letterSpacing: "0.06em" }}
              >
                Permissions ({access?.permissions.length ?? 0})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {access?.permissions.map((p) => (
                  <span
                    key={p}
                    className="cmc-mono cmc-chip"
                    style={{ color: "var(--c-fg-2)" }}
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
