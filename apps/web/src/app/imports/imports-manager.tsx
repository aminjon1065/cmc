"use client";

import { useState } from "react";
import type { ImportJob, ImportKind, ImportRowError } from "@cmc/contracts";
import {
  createImportAction,
  initUploadAction,
  listErrorsAction,
  listImportsAction,
} from "./actions";

const KINDS: { value: ImportKind; label: string; accept: string }[] = [
  { value: "csv_incidents", label: "CSV → Incidents", accept: ".csv,text/csv" },
  {
    value: "xlsx_incidents",
    label: "Excel → Incidents",
    accept: ".xlsx",
  },
  {
    value: "geojson_gis",
    label: "GeoJSON → GIS layer",
    accept: ".geojson,.json,application/geo+json,application/json",
  },
  {
    value: "shapefile_gis",
    label: "Shapefile (.zip) → GIS layer",
    accept: ".zip,application/zip",
  },
];

const needsLayer = (k: ImportKind) => k.endsWith("_gis");

type Msg = { kind: "ok" | "err"; text: string } | null;

export function ImportsManager({
  initialJobs,
  canRun,
  layers,
}: {
  initialJobs: ImportJob[];
  canRun: boolean;
  layers: { id: string; name: string }[];
}) {
  const [jobs, setJobs] = useState<ImportJob[]>(initialJobs);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ImportKind>("csv_incidents");
  const [layerId, setLayerId] = useState<string>("");
  const [fileKey, setFileKey] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [errs, setErrs] = useState<Record<string, ImportRowError[]>>({});
  const [openJob, setOpenJob] = useState<string | null>(null);

  async function refresh() {
    const r = await listImportsAction();
    if (r.ok) setJobs(r.data);
  }

  async function submit() {
    if (!file) return setMsg({ kind: "err", text: "Choose a file first." });
    if (needsLayer(kind) && !layerId)
      return setMsg({ kind: "err", text: "Choose a target GIS layer." });
    setBusy(true);
    setMsg(null);

    const contentType = file.type || "application/octet-stream";
    const init = await initUploadAction(file.name, contentType);
    if (!init.ok) {
      setBusy(false);
      return setMsg({ kind: "err", text: init.error });
    }
    try {
      const put = await fetch(init.data.upload.url, {
        method: "PUT",
        body: file,
        headers: init.data.upload.headers,
      });
      if (!put.ok) throw new Error(`upload failed (HTTP ${put.status})`);
    } catch (e) {
      setBusy(false);
      return setMsg({
        kind: "err",
        text: e instanceof Error ? e.message : "Upload failed.",
      });
    }

    const created = await createImportAction({
      kind,
      sourceKey: init.data.sourceKey,
      targetId: needsLayer(kind) ? layerId : undefined,
    });
    setBusy(false);
    if (!created.ok) return setMsg({ kind: "err", text: created.error });

    setJobs((j) => [created.data, ...j]);
    setMsg({ kind: "ok", text: "Import queued — refresh to watch progress." });
    setFile(null);
    setFileKey((k) => k + 1);
    setOpen(false);
  }

  async function toggleErrors(jobId: string) {
    if (openJob === jobId) {
      setOpenJob(null);
      return;
    }
    setOpenJob(jobId);
    if (!errs[jobId]) {
      const r = await listErrorsAction(jobId);
      if (r.ok) setErrs((e) => ({ ...e, [jobId]: r.data }));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {canRun && !open && (
          <button className="cmc-btn" onClick={() => setOpen(true)}>
            + New import
          </button>
        )}
        <div className="flex-1" />
        <button className="cmc-btn" onClick={refresh}>
          ↻ Refresh
        </button>
      </div>

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

      {open && (
        <div className="cmc-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="cmc-label">Type</span>
              <select
                className="cmc-input"
                style={{ width: 230 }}
                value={kind}
                onChange={(e) => setKind(e.target.value as ImportKind)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>

            {needsLayer(kind) && (
              <label className="flex flex-col gap-1">
                <span className="cmc-label">Target layer</span>
                <select
                  className="cmc-input"
                  style={{ width: 200 }}
                  value={layerId}
                  onChange={(e) => setLayerId(e.target.value)}
                >
                  <option value="">— select —</option>
                  {layers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="cmc-label">File</span>
              <input
                key={fileKey}
                type="file"
                className="text-[12px]"
                accept={KINDS.find((k) => k.value === kind)?.accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <button className="cmc-btn" onClick={submit} disabled={busy}>
              {busy ? "Uploading…" : "Start import"}
            </button>
            <button
              className="cmc-btn"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setFile(null);
                setFileKey((k) => k + 1);
              }}
            >
              Cancel
            </button>
          </div>
          {needsLayer(kind) && layers.length === 0 && (
            <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
              No GIS layers available — create one on the map first.
            </div>
          )}
        </div>
      )}

      <div className="cmc-card">
        {jobs.length === 0 ? (
          <div
            className="p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            No imports yet.
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
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Inserted</th>
                <th className="px-4 py-2 font-medium">Quarantined</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  open={openJob === j.id}
                  errors={errs[j.id]}
                  onToggle={() => toggleErrors(j.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ImportJob["status"] }) {
  const color =
    status === "completed"
      ? "var(--c-accent)"
      : status === "failed"
        ? "var(--c-sev-1)"
        : "var(--c-fg-3)";
  return (
    <span
      className="cmc-mono rounded px-1.5 py-0.5 text-[9.5px] uppercase"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {status}
    </span>
  );
}

function JobRow({
  job,
  open,
  errors,
  onToggle,
}: {
  job: ImportJob;
  open: boolean;
  errors: ImportRowError[] | undefined;
  onToggle: () => void;
}) {
  return (
    <>
      <tr style={{ borderBottom: "0.5px solid var(--c-line-1)" }}>
        <td className="cmc-mono px-4 py-2.5 text-[11px]" style={{ color: "var(--c-fg-1)" }}>
          {job.kind}
        </td>
        <td className="px-4 py-2.5">
          <StatusBadge status={job.status} />
          {job.error && (
            <span
              className="ml-2 text-[10.5px]"
              style={{ color: "var(--c-fg-3)" }}
              title={job.error}
            >
              {job.error.slice(0, 40)}
            </span>
          )}
        </td>
        <td className="px-4 py-2.5" style={{ color: "var(--c-fg-2)" }}>
          {job.insertedRows}/{job.totalRows}
        </td>
        <td className="px-4 py-2.5" style={{ color: "var(--c-fg-2)" }}>
          {job.failedRows}
        </td>
        <td className="cmc-mono px-4 py-2.5 text-[10.5px]" style={{ color: "var(--c-fg-3)" }}>
          {new Date(job.createdAt).toLocaleString()}
        </td>
        <td className="px-4 py-2.5 text-right">
          {job.failedRows > 0 && (
            <button
              className="text-[11px] hover:underline"
              style={{ color: "var(--c-accent)" }}
              onClick={onToggle}
            >
              {open ? "Hide" : `View ${job.failedRows} errors`}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="px-4 py-2" style={{ background: "var(--c-bg-2)" }}>
            {!errors ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                Loading…
              </div>
            ) : errors.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                No quarantined rows.
              </div>
            ) : (
              <ul className="flex flex-col gap-1 py-1">
                {errors.map((e, i) => (
                  <li key={i} className="text-[11px]" style={{ color: "var(--c-fg-2)" }}>
                    <span className="cmc-mono" style={{ color: "var(--c-sev-1)" }}>
                      row {e.rowNum}
                    </span>
                    {" — "}
                    {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
