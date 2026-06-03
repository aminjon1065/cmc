import type { Metadata } from "next";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { fetchRegions } from "@/lib/regions";
import { RegionsManager } from "./regions-manager";

export const metadata: Metadata = { title: "Regions · Administration" };

export default async function AdminRegionsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [access, regions] = await Promise.all([getMyAccess(), fetchRegions()]);
  const canManage = hasPermission(access, "region:manage");

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "Regions"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration · Regions</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Regions
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Regions divide users + operational data for visibility. Regional users
            see only their region; the head office (<code>region:all</code>) sees
            all.
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">
              {regions.length} region(s){canManage ? "" : " · read-only"}
            </span>
          </div>
          <div className="p-4">
            <RegionsManager regions={regions} canManage={canManage} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
