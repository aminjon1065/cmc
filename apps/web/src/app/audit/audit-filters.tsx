"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AUDIT_OUTCOMES } from "@cmc/contracts";

/** Filter bar for the audit log — pushes filters to the URL (server re-fetch). */
export function AuditFilters() {
  const t = useTranslations("audit");
  const router = useRouter();
  const sp = useSearchParams();
  const [action, setAction] = useState(sp.get("action") ?? "");
  const [resourceType, setResourceType] = useState(sp.get("resourceType") ?? "");
  const [outcome, setOutcome] = useState(sp.get("outcome") ?? "");

  function apply() {
    const qs = new URLSearchParams();
    if (action.trim()) qs.set("action", action.trim());
    if (resourceType.trim()) qs.set("resourceType", resourceType.trim());
    if (outcome) qs.set("outcome", outcome);
    const s = qs.toString();
    router.push(s ? `/audit?${s}` : "/audit");
  }

  function reset() {
    setAction("");
    setResourceType("");
    setOutcome("");
    router.push("/audit");
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="cmc-label px-0.5">{t("fAction")}</span>
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder={t("fActionPh")}
          className="cmc-input"
          style={{ width: 200 }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="cmc-label px-0.5">{t("fResource")}</span>
        <input
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder={t("fResourcePh")}
          className="cmc-input"
          style={{ width: 160 }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="cmc-label px-0.5">{t("fOutcome")}</span>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="cmc-input"
          style={{ width: 140 }}
        >
          <option value="">{t("fOutcomeAny")}</option>
          {AUDIT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t(`outcome.${o}`)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={apply} className="cmc-btn cmc-btn-primary">
        {t("apply")}
      </button>
      <button type="button" onClick={reset} className="cmc-btn">
        {t("reset")}
      </button>
    </div>
  );
}
