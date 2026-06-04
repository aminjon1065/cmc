"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { BrandingCopy } from "@cmc/contracts";
import { updateBrandingAction } from "./actions";

/**
 * Copy fields, with label catalog keys + which render as a textarea.
 * `labelKey` indexes into the `admin.tenant` namespace.
 */
const COPY_FIELDS: {
  key: keyof BrandingCopy;
  labelKey: string;
  multiline?: boolean;
}[] = [
  { key: "orgName", labelKey: "copyOrgName" },
  { key: "orgShort", labelKey: "copyOrgShort" },
  { key: "country", labelKey: "copyCountry" },
  { key: "statusLocation", labelKey: "copyStatusLocation" },
  { key: "dataCenter", labelKey: "copyDataCenter" },
  { key: "muralKicker", labelKey: "copyMuralKicker" },
  { key: "muralHeadline", labelKey: "copyMuralHeadline", multiline: true },
  { key: "muralSubcopy", labelKey: "copyMuralSubcopy", multiline: true },
  { key: "buildLabel", labelKey: "copyBuildLabel" },
  { key: "complianceLine", labelKey: "copyComplianceLine" },
  { key: "metaTitle", labelKey: "copyMetaTitle" },
  { key: "metaDescription", labelKey: "copyMetaDescription", multiline: true },
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
  const t = useTranslations("admin");
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
    setMsg({ ok: true, text: t("tenant.brandingSaved") });
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">{t("tenant.fDefaultLocale")}</span>
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
          <span className="cmc-label">{t("tenant.fLogoUrl")}</span>
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
            <span className="cmc-label">{t(`tenant.${f.labelKey}`)}</span>
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
          {busy ? t("tenant.saving") : t("tenant.saveBranding")}
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
