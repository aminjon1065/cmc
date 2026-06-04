"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createWorkflowAction } from "./actions";

/** Create a draft workflow, then jump straight into its editor. */
export function NewWorkflowButton() {
  const router = useRouter();
  const t = useTranslations("workflows");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await createWorkflowAction(name);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.push(`/workflows/${res.data.id}`);
  }

  if (!open) {
    return (
      <button className="cmc-btn" onClick={() => setOpen(true)}>
        {t("newWorkflow")}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        className="cmc-input"
        style={{ width: 200 }}
        placeholder={t("workflowNamePlaceholder")}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
      />
      <button className="cmc-btn" onClick={create} disabled={busy}>
        {busy ? t("creating") : t("create")}
      </button>
      <button className="cmc-btn" onClick={() => setOpen(false)} disabled={busy}>
        {t("cancel")}
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: "var(--c-sev-1)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
