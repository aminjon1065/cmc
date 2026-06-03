import type { Metadata } from "next";
import { auth } from "@/auth";
import { ApiKeysListResponseSchema, type ApiKey } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { ApiKeysManager } from "./api-keys-manager";

export const metadata: Metadata = { title: "API Keys" };

async function fetchKeys(): Promise<
  { ok: true; keys: ApiKey[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/api-keys");
    const parsed = ApiKeysListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, keys: parsed.data.apiKeys };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to manage API keys."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load API keys." };
  }
}

export default async function ApiKeysPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access] = await Promise.all([fetchKeys(), getMyAccess()]);
  // A key's scopes must be ⊆ the creator's permissions — offer exactly those.
  const availableScopes = [...(access?.permissions ?? [])].sort();

  return (
    <AppShell
      active="admin"
      crumbs={["Administration", "API Keys"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Administrator" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Administration · API Keys</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            API Keys
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            Scoped keys for programmatic access to <code className="cmc-mono">/v1</code>.
            Send as <code className="cmc-mono">X-API-Key</code> or{" "}
            <code className="cmc-mono">Authorization: Bearer</code>.
          </div>
        </div>
      </div>

      <div className="p-5">
        {!result.ok ? (
          <div
            className="cmc-card m-0 rounded-md p-3 text-[12px]"
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
          <ApiKeysManager keys={result.keys} availableScopes={availableScopes} />
        )}
      </div>
    </AppShell>
  );
}
