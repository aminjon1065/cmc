"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateTenantAction } from "./actions";

export function TenantIdentityForm({
  slug,
  initialName,
}: {
  slug: string;
  initialName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await updateTenantAction({ name });
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: res.error });
      return;
    }
    setMsg({ ok: true, text: "Saved." });
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Tenant name</span>
          <input
            className="cmc-input"
            style={{ width: 280 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Slug (immutable)</span>
          <input
            className="cmc-input cmc-mono"
            style={{ width: 180 }}
            value={slug}
            disabled
          />
        </label>
        <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save name"}
        </button>
      </div>
      {msg && (
        <div
          className="text-[11.5px]"
          style={{ color: msg.ok ? "var(--c-ok)" : "var(--c-sev-1)" }}
          role="status"
        >
          {msg.text}
        </div>
      )}
    </form>
  );
}
