"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Region } from "@cmc/contracts";
import {
  createRegionAction,
  updateRegionAction,
  deleteRegionAction,
} from "./actions";

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

export function RegionsManager({
  regions,
  canManage,
}: {
  regions: Region[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  async function run<T>(p: Promise<Res<T>>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await p;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function onCreate() {
    if (!code.trim() || !name.trim()) return;
    const ok = await run(
      createRegionAction({ code: code.trim().toUpperCase(), name: name.trim() }),
    );
    if (ok) {
      setCode("");
      setName("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="cmc-label">Code</span>
            <input
              className="cmc-input"
              style={{ width: 150 }}
              placeholder="SUGHD"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 200 }}>
            <span className="cmc-label">Name</span>
            <input
              className="cmc-input"
              placeholder="Согдийская область"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim() && name.trim())
                  void onCreate();
              }}
            />
          </label>
          <button
            className="cmc-btn"
            disabled={busy || !code.trim() || !name.trim()}
            onClick={() => void onCreate()}
          >
            Add region
          </button>
        </div>
      )}

      {error && (
        <div className="text-[11px]" style={{ color: "var(--c-sev-1)" }}>
          {error}
        </div>
      )}

      <div className="flex flex-col">
        {regions.length === 0 ? (
          <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
            No regions yet.
          </div>
        ) : (
          regions.map((r) => (
            <RegionRow
              key={r.id}
              region={r}
              canManage={canManage}
              busy={busy}
              run={run}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RegionRow({
  region,
  canManage,
  busy,
  run,
}: {
  region: Region;
  canManage: boolean;
  busy: boolean;
  run: <T>(p: Promise<Res<T>>) => Promise<boolean>;
}) {
  const [name, setName] = useState(region.name);
  const dirty = name.trim() !== region.name && name.trim().length > 0;

  return (
    <div
      className="flex items-center gap-2 py-2"
      style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
    >
      <span className="cmc-mono cmc-chip" style={{ color: "var(--c-fg-2)" }}>
        {region.code}
      </span>
      {canManage ? (
        <input
          className="cmc-input"
          style={{ flex: 1, maxWidth: 300 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      ) : (
        <span className="text-[12px]" style={{ color: "var(--c-fg-1)" }}>
          {region.name}
        </span>
      )}
      <div className="flex-1" />
      {canManage && (
        <>
          {dirty && (
            <button
              className="cmc-btn"
              disabled={busy}
              onClick={() =>
                void run(updateRegionAction(region.id, { name: name.trim() }))
              }
            >
              Save
            </button>
          )}
          <button
            className="cmc-btn"
            disabled={busy}
            style={{ color: "var(--c-sev-1)" }}
            onClick={() => {
              if (confirm(`Delete region "${region.name}"?`))
                void run(deleteRegionAction(region.id));
            }}
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}
