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
import { MediaWorkspace } from "./media-workspace";

export const metadata: Metadata = { title: "Media" };

async function fetchAssets(): Promise<
  { ok: true; assets: MediaAsset[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/media/assets");
    const parsed = MediaAssetsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, assets: parsed.data.assets };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view media."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load media." };
  }
}

export default async function MediaPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access] = await Promise.all([fetchAssets(), getMyAccess()]);

  return (
    <AppShell
      active="media"
      crumbs={["Knowledge", "Media"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
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
              {result.error}
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
