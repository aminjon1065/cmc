"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWorkflowAction } from "./actions";

/** Create a draft workflow, then jump straight into its editor. */
export function NewWorkflowButton() {
  const router = useRouter();
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
        + New workflow
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        className="cmc-input"
        style={{ width: 200 }}
        placeholder="Workflow name"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
      />
      <button className="cmc-btn" onClick={create} disabled={busy}>
        {busy ? "Creating…" : "Create"}
      </button>
      <button className="cmc-btn" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: "var(--c-sev-1)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
