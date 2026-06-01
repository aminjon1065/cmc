import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  TenantSettingsResponseSchema,
  type TenantSettingsResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { TenantIdentityForm } from "./tenant-identity-form";
import { BrandingForm } from "./branding-form";

export const metadata: Metadata = { title: "Tenant · Administration" };

async function fetchTenant(): Promise<
  { ok: true; tenant: TenantSettingsResponse } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/tenant");
    const parsed = TenantSettingsResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, tenant: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: `API ${err.status}` };
    return { ok: false, error: "Failed to load tenant." };
  }
}

export default async function AdminTenantPage() {
  const session = await auth();
  const branding = await getBranding();
  const result = await fetchTenant();

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "Tenant"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: branding.copy.orgName, orgShort: branding.copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration · Tenant</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Tenant Settings
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Identity and branding for this tenant.
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-5">
        {/* Identity */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Identity</span>
          </div>
          <div className="p-4">
            {result.ok ? (
              <TenantIdentityForm
                slug={result.tenant.slug}
                initialName={result.tenant.name}
              />
            ) : (
              <div
                className="rounded-md p-3 text-[12px]"
                style={{
                  color: "var(--c-sev-1)",
                  background: "var(--c-sev-1-soft)",
                  border:
                    "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
                }}
              >
                {result.error}
              </div>
            )}
          </div>
        </div>

        {/* Branding */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Branding</span>
          </div>
          <div className="p-4">
            <BrandingForm
              initialLocale={branding.localeDefault}
              initialLogoUrl={branding.logoUrl}
              initialCopy={branding.copy}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
