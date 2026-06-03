"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
    if (!confirm("Revoke this key? Clients using it will stop working.")) return;
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
            New key “{created.name}” — copy it now, it won’t be shown again
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
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button className="cmc-btn" onClick={() => setCreated(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create */}
      {!open ? (
        <div>
          <button className="cmc-btn cmc-btn-primary" onClick={() => setOpen(true)}>
            + New API key
          </button>
        </div>
      ) : (
        <form onSubmit={onCreate} className="cmc-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="cmc-label">Name</span>
              <input
                className="cmc-input"
                style={{ width: 240 }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CI ingest"
                maxLength={120}
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="cmc-label">Expires in (days, optional)</span>
              <input
                className="cmc-input"
                style={{ width: 160 }}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="never"
                inputMode="numeric"
              />
            </label>
          </div>

          <div>
            <div className="cmc-label mb-1.5">
              Scopes ({scopes.size} selected) — limited to your own permissions
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
              {busy ? "Creating…" : "Create key"}
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
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* List */}
      <div className="cmc-card">
        {keys.length === 0 ? (
          <div className="p-6 text-center text-[12px]" style={{ color: "var(--c-fg-3)" }}>
            No API keys yet.
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
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Prefix</th>
                <th className="px-4 py-2 font-medium">Scopes</th>
                <th className="px-4 py-2 font-medium">Last used</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const revoked = !!k.revokedAt;
                const expired = !!k.expiresAt && new Date(k.expiresAt) <= new Date();
                const state = revoked ? "revoked" : expired ? "expired" : "active";
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
                        {state}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!revoked && (
                        <button
                          className="cmc-btn"
                          style={{ color: "var(--c-sev-1)" }}
                          onClick={() => onRevoke(k.id)}
                        >
                          Revoke
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
