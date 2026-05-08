"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteDocumentAction, getDownloadUrlAction } from "./actions";

export function DocumentRowActions({
  documentId,
  documentName,
}: {
  documentId: string;
  documentName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"download" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDownload() {
    setBusy("download");
    setError(null);
    const res = await getDownloadUrlAction(documentId);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Open in a new tab — the response carries Content-Disposition so the
    // browser saves the file under the original name.
    window.open(res.data.url, "_blank", "noopener,noreferrer");
  }

  async function onDelete() {
    if (!confirm(`Delete "${documentName}"? This cannot be undone.`)) return;
    setBusy("delete");
    setError(null);
    const res = await deleteDocumentAction(documentId);
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onDownload}
        disabled={busy !== null}
        className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
      >
        {busy === "download" ? "…" : "Download"}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy !== null}
        className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        {busy === "delete" ? "…" : "Delete"}
      </button>
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
