import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { ApiKeysListResponseSchema, type ApiKey } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { ApiKeysManager } from "./api-keys-manager";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin");
  return { title: t("apiKeys.metaTitle") };
}

type KeysFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchKeys(): Promise<
  { ok: true; keys: ApiKey[] } | KeysFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/api-keys");
    const parsed = ApiKeysListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, keys: parsed.data.apiKeys };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function ApiKeysPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("admin");
  const tc = await getTranslations("common");
  const [result, access] = await Promise.all([fetchKeys(), getMyAccess()]);
  // A key's scopes must be ⊆ the creator's permissions — offer exactly those.
  const availableScopes = [...(access?.permissions ?? [])].sort();

  return (
    <AppShell
      active="admin"
      crumbs={[t("crumbAdministration"), t("crumbApiKeys")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleAdmin") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("apiKeys.kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("apiKeys.title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {t("apiKeys.subtitlePre")}{" "}
            <code className="cmc-mono">/v1</code>
            {t("apiKeys.subtitleSendAs")}{" "}
            <code className="cmc-mono">X-API-Key</code>{" "}
            {t("apiKeys.subtitleOr")}{" "}
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
            {result.errorKey === "errApi"
              ? t("apiKeys.errApi", { status: result.status ?? 0 })
              : t(`apiKeys.${result.errorKey}`)}
          </div>
        ) : (
          <ApiKeysManager keys={result.keys} availableScopes={availableScopes} />
        )}
      </div>
    </AppShell>
  );
}
