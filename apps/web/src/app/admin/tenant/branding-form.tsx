"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandingCopy } from "@cmc/contracts";
import { updateBrandingAction } from "./actions";

/** Copy fields, with labels + which render as a textarea. */
const COPY_FIELDS: {
  key: keyof BrandingCopy;
  label: string;
  multiline?: boolean;
}[] = [
  { key: "orgName", label: "Organisation name" },
  { key: "orgShort", label: "Short qualifier" },
  { key: "country", label: "Country / jurisdiction" },
  { key: "statusLocation", label: "Status location label" },
  { key: "dataCenter", label: "Data-center line" },
  { key: "muralKicker", label: "Login mural kicker" },
  { key: "muralHeadline", label: "Login mural headline", multiline: true },
  { key: "muralSubcopy", label: "Login mural sub-copy", multiline: true },
  { key: "buildLabel", label: "Build label" },
  { key: "complianceLine", label: "Compliance line" },
  { key: "metaTitle", label: "Meta title" },
  { key: "metaDescription", label: "Meta description", multiline: true },
];

export function BrandingForm({
  initialLocale,
  initialLogoUrl,
  initialCopy,
}: {
  initialLocale: string;
  initialLogoUrl: string | null;
  initialCopy: BrandingCopy;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState(initialLocale);
  const [logoUrl, setLogoUrl] = useState(initialLogoUrl ?? "");
  const [copy, setCopy] = useState<BrandingCopy>(initialCopy);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function setField(key: keyof BrandingCopy, value: string) {
    setCopy((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await updateBrandingAction({
      localeDefault: locale,
      logoUrl: logoUrl.trim() === "" ? null : logoUrl.trim(),
      copy,
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: res.error });
      return;
    }
    setMsg({ ok: true, text: "Branding saved." });
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Default locale</span>
          <input
            className="cmc-input"
            style={{ width: 90 }}
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            placeholder="en / ru / tg"
            maxLength={12}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 260 }}>
          <span className="cmc-label">Logo URL (blank = built-in emblem)</span>
          <input
            className="cmc-input"
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…"
            maxLength={1024}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {COPY_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="cmc-label">{f.label}</span>
            {f.multiline ? (
              <textarea
                className="cmc-input"
                style={{ height: 56, paddingTop: 6 }}
                value={copy[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            ) : (
              <input
                className="cmc-input"
                value={copy[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            )}
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save branding"}
        </button>
        {msg && (
          <span
            className="text-[11.5px]"
            style={{ color: msg.ok ? "var(--c-ok)" : "var(--c-sev-1)" }}
            role="status"
          >
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
