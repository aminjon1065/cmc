import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { fetchRegions } from "@/lib/regions";
import { RegionsManager } from "./regions-manager";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("regions.metaTitle") };
}

export default async function AdminRegionsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  const [access, regions] = await Promise.all([getMyAccess(), fetchRegions()]);
  const canManage = hasPermission(access, "region:manage");

  return (
    <AppShell
      active="admin"
      crumbs={[t("crumbAdministration"), t("crumbRegions")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleAdmin") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("regions.kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("regions.title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {t("regions.subtitlePre")}
            <code>region:all</code>
            {t("regions.subtitlePost")}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">
              {t("regions.countLabel", { count: regions.length })}
              {canManage ? "" : t("regions.readOnlySuffix")}
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
