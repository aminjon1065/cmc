"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { MediaAsset } from "@cmc/contracts";
import { listAssetsAction, requestTranscodeAction } from "./actions";

const MediaPlayer = dynamic(
  () => import("./media-player").then((m) => m.MediaPlayer),
  { ssr: false },
);

type Msg = { kind: "ok" | "err"; text: string } | null;

const STATUS_COLOR: Record<string, string> = {
  ready: "var(--c-accent)",
  processing: "var(--c-sev-2)",
  pending: "var(--c-fg-3)",
  failed: "var(--c-sev-1)",
};

export function MediaWorkspace({
  initialAssets,
  canWrite,
}: {
  initialAssets: MediaAsset[];
  canWrite: boolean;
}) {
  const [assets, setAssets] = useState<MediaAsset[]>(initialAssets);
  const [docId, setDocId] = useState("");
  const [watermark, setWatermark] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  async function refresh() {
    const r = await listAssetsAction();
    if (r.ok) setAssets(r.data);
  }

  // Poll while anything is still transcoding so statuses advance.
  useEffect(() => {
    if (!assets.some((a) => a.status === "pending" || a.status === "processing")) {
      return;
    }
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [assets]);

  async function transcode() {
    if (!docId.trim()) return;
    setBusy(true);
    setMsg(null);
    const r = await requestTranscodeAction(docId, watermark);
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "err", text: r.error });
      return;
    }
    setDocId("");
    setWatermark("");
    setMsg({ kind: "ok", text: "Transcode queued." });
    await refresh();
  }

  return (
    <div className="flex flex-col gap-3 p-5" style={{ maxWidth: 820 }}>
      {msg && (
        <div
          className="rounded-md p-2.5 text-[12px]"
          style={{
            color: msg.kind === "ok" ? "var(--c-accent)" : "var(--c-sev-1)",
            background:
              msg.kind === "ok"
                ? "color-mix(in srgb, var(--c-accent) 10%, transparent)"
                : "var(--c-sev-1-soft)",
          }}
        >
          {msg.text}
        </div>
      )}

      {canWrite && (
        <div className="cmc-card flex items-center gap-2 p-3">
          <input
            className="cmc-input"
            style={{ flex: 1 }}
            placeholder="Document ID to make streamable (a video/audio document)…"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && docId.trim()) void transcode();
            }}
          />
          <input
            className="cmc-input"
            style={{ width: 180 }}
            placeholder="Watermark (optional)"
            value={watermark}
            onChange={(e) => setWatermark(e.target.value)}
          />
          <button
            className="cmc-btn"
            disabled={busy || !docId.trim()}
            onClick={() => void transcode()}
          >
            {busy ? "…" : "Make streamable"}
          </button>
        </div>
      )}

      {playing && (
        <div className="cmc-card flex flex-col">
          <div className="cmc-card-header flex items-center gap-2">
            <span className="cmc-label">Now playing</span>
            <div className="flex-1" />
            <button className="cmc-btn" onClick={() => setPlaying(null)}>
              Close
            </button>
          </div>
          <div className="p-3">
            <MediaPlayer assetId={playing} />
          </div>
        </div>
      )}

      <div className="cmc-card flex flex-col">
        <div
          className="px-3 py-2"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <span className="cmc-label">Media assets</span>
        </div>
        <div className="flex flex-col">
          {assets.length === 0 ? (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
              No media assets yet.
            </div>
          ) : (
            assets.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 px-3 py-2"
                style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
              >
                <span
                  className="cmc-mono text-[10px] uppercase"
                  style={{ color: STATUS_COLOR[a.status] ?? "var(--c-fg-3)" }}
                >
                  {a.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px]" style={{ color: "var(--c-fg-1)" }}>
                    {a.kind} · doc {a.documentId.slice(0, 8)}
                  </div>
                  {a.error && (
                    <div className="truncate text-[10px]" style={{ color: "var(--c-sev-1)" }}>
                      {a.error}
                    </div>
                  )}
                </div>
                {a.status === "ready" && (
                  <button className="cmc-btn" onClick={() => setPlaying(a.id)}>
                    ▶ Play
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
