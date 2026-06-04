import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  MediaAssetsListResponseSchema,
  type MediaAsset,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { MediaWorkspace } from "./media-workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("media");
  return { title: t("metaTitle") };
}

type AssetsFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchAssets(): Promise<
  { ok: true; assets: MediaAsset[] } | AssetsFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/media/assets");
    const parsed = MediaAssetsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, assets: parsed.data.assets };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function MediaPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("media");
  const tc = await getTranslations("common");
  const [result, access] = await Promise.all([fetchAssets(), getMyAccess()]);

  return (
    <AppShell
      active="media"
      crumbs={[t("crumbKnowledge"), t("crumbMedia")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
    >
      {!result.ok ? (
        <div className="p-5">
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
              {result.errorKey === "errApi"
                ? t("errApi", { status: result.status ?? 0 })
                : t(result.errorKey)}
            </div>
          </div>
        </div>
      ) : (
        <MediaWorkspace
          initialAssets={result.assets}
          canWrite={hasPermission(access, "media:write")}
        />
      )}
    </AppShell>
  );
}
