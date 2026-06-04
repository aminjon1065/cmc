"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ApiKey } from "@cmc/contracts";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—";
}

export function ApiKeysManager({
  keys,
  availableScopes,
}: {
  keys: ApiKey[];
  availableScopes: string[];
}) {
  const router = useRouter();
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiresInDays, setExpiresInDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ secret: string; name: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  function toggle(s: string) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const days = expiresInDays.trim() ? Number(expiresInDays) : undefined;
    const res = await createApiKeyAction({
      name: name.trim(),
      scopes: [...scopes],
      ...(days && Number.isFinite(days) ? { expiresInDays: days } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setCreated({ secret: res.data.secret, name: res.data.apiKey.name });
    setName("");
    setScopes(new Set());
    setExpiresInDays("");
    setOpen(false);
    setCopied(false);
    router.refresh();
  }

  async function onRevoke(id: string) {
    if (!confirm(t("apiKeys.confirmRevoke"))) return;
    const res = await revokeApiKeyAction(id);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Secret shown once */}
      {created && (
        <div
          className="cmc-card p-4"
          style={{
            border: "0.5px solid color-mix(in srgb, var(--c-accent) 40%, transparent)",
            background: "color-mix(in srgb, var(--c-accent) 7%, transparent)",
          }}
        >
          <div className="cmc-label mb-1">
            {t("apiKeys.newKeyLabel", { name: created.name })}
          </div>
          <div className="flex items-center gap-2">
            <code
              className="cmc-mono flex-1 overflow-x-auto rounded p-2 text-[12px]"
              style={{ background: "var(--c-bg-0)", color: "var(--c-fg-1)" }}
            >
              {created.secret}
            </code>
            <button
              className="cmc-btn"
              onClick={async () => {
                await navigator.clipboard?.writeText(created.secret);
                setCopied(true);
              }}
            >
              {copied ? t("apiKeys.copied") : t("apiKeys.copy")}
            </button>
            <button className="cmc-btn" onClick={() => setCreated(null)}>
              {t("apiKeys.dismiss")}
            </button>
          </div>
        </div>
      )}

      {/* Create */}
      {!open ? (
        <div>
          <button className="cmc-btn cmc-btn-primary" onClick={() => setOpen(true)}>
            {t("apiKeys.newApiKey")}
          </button>
        </div>
      ) : (
        <form onSubmit={onCreate} className="cmc-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="cmc-label">{t("apiKeys.fName")}</span>
              <input
                className="cmc-input"
                style={{ width: 240 }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.fNamePlaceholder")}
                maxLength={120}
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="cmc-label">{t("apiKeys.fExpiresIn")}</span>
              <input
                className="cmc-input"
                style={{ width: 160 }}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder={t("apiKeys.fExpiresPlaceholder")}
                inputMode="numeric"
              />
            </label>
          </div>

          <div>
            <div className="cmc-label mb-1.5">
              {t("apiKeys.scopesLabel", { count: scopes.size })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {availableScopes.map((s) => {
                const on = scopes.has(s);
                return (
                  <button
                    type="button"
                    key={s}
                    onClick={() => toggle(s)}
                    className="cmc-mono rounded px-2 py-1 text-[10.5px]"
                    style={{
                      border: "0.5px solid var(--c-line-2)",
                      background: on
                        ? "color-mix(in srgb, var(--c-accent) 16%, transparent)"
                        : "var(--c-bg-1)",
                      color: on ? "var(--c-accent)" : "var(--c-fg-3)",
                    }}
                  >
                    {on ? "✓ " : ""}
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="text-[11.5px]" style={{ color: "var(--c-sev-1)" }} role="alert">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
              {busy ? t("apiKeys.creating") : t("apiKeys.createKey")}
            </button>
            <button
              type="button"
              className="cmc-btn"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={busy}
            >
              {t("apiKeys.cancel")}
            </button>
          </div>
        </form>
      )}

      {/* List */}
      <div className="cmc-card">
        {keys.length === 0 ? (
          <div className="p-6 text-center text-[12px]" style={{ color: "var(--c-fg-3)" }}>
            {t("apiKeys.noKeys")}
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr
                className="text-left"
                style={{
                  color: "var(--c-fg-4)",
                  borderBottom: "0.5px solid var(--c-line-2)",
                }}
              >
                <th className="px-4 py-2 font-medium">{t("apiKeys.thName")}</th>
                <th className="px-4 py-2 font-medium">{t("apiKeys.thPrefix")}</th>
                <th className="px-4 py-2 font-medium">{t("apiKeys.thScopes")}</th>
                <th className="px-4 py-2 font-medium">
                  {t("apiKeys.thLastUsed")}
                </th>
                <th className="px-4 py-2 font-medium">{t("apiKeys.thStatus")}</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const revoked = !!k.revokedAt;
                const expired = !!k.expiresAt && new Date(k.expiresAt) <= new Date();
                const state = revoked ? "revoked" : expired ? "expired" : "active";
                const stateKey = revoked
                  ? "stateRevoked"
                  : expired
                    ? "stateExpired"
                    : "stateActive";
                return (
                  <tr key={k.id} style={{ borderBottom: "0.5px solid var(--c-line-1)" }}>
                    <td className="px-4 py-2.5" style={{ color: "var(--c-fg-1)" }}>
                      {k.name}
                    </td>
                    <td className="cmc-mono px-4 py-2.5 text-[10.5px]" style={{ color: "var(--c-fg-2)" }}>
                      {k.keyPrefix}…
                    </td>
                    <td className="px-4 py-2.5" style={{ color: "var(--c-fg-3)" }}>
                      <span className="cmc-mono text-[10px]">
                        {k.scopes.length <= 3
                          ? k.scopes.join(", ")
                          : `${k.scopes.slice(0, 3).join(", ")} +${k.scopes.length - 3}`}
                      </span>
                    </td>
                    <td className="cmc-mono px-4 py-2.5 text-[10.5px]" style={{ color: "var(--c-fg-3)" }}>
                      {fmt(k.lastUsedAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className="cmc-mono rounded px-1.5 py-0.5 text-[9.5px] uppercase"
                        style={{
                          color: state === "active" ? "var(--c-accent)" : "var(--c-fg-3)",
                          background:
                            state === "active"
                              ? "color-mix(in srgb, var(--c-accent) 12%, transparent)"
                              : "var(--c-bg-3)",
                        }}
                      >
                        {t(`apiKeys.${stateKey}`)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!revoked && (
                        <button
                          className="cmc-btn"
                          style={{ color: "var(--c-sev-1)" }}
                          onClick={() => onRevoke(k.id)}
                        >
                          {t("apiKeys.revoke")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
