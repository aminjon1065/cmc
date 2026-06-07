import type { Metadata } from "next";
import { auth } from "@/auth";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { getTranslations } from "next-intl/server";
import { AiConsole } from "./ai-console";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ai");
  return { title: t("metaTitle") };
}

export default async function AiPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("ai");
  const tc = await getTranslations("common");
  const access = await getMyAccess();
  const canUse = hasPermission(access, "llm:use");

  return (
    <AppShell
      active="ai"
      crumbs={[t("crumbIntel"), t("crumbAi")]}
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
      </div>

      <div className="p-5">
        {canUse ? (
          <AiConsole />
        ) : (
          <div
            className="cmc-card p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {t("noAccess")}
          </div>
        )}
      </div>
    </AppShell>
  );
}
