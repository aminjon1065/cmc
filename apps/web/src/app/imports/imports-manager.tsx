"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FormattedDate } from "@/components/cmc/formatted-date";
import type { ImportJob, ImportKind, ImportRowError } from "@cmc/contracts";
import {
  createImportAction,
  initUploadAction,
  listErrorsAction,
  listImportsAction,
} from "./actions";

const KINDS: { value: ImportKind; labelKey: string; accept: string }[] = [
  { value: "csv_incidents", labelKey: "kindCsvIncidents", accept: ".csv,text/csv" },
  {
    value: "xlsx_incidents",
    labelKey: "kindXlsxIncidents",
    accept: ".xlsx",
  },
  {
    value: "geojson_gis",
    labelKey: "kindGeojsonGis",
    accept: ".geojson,.json,application/geo+json,application/json",
  },
  {
    value: "shapefile_gis",
    labelKey: "kindShapefileGis",
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
  const t = useTranslations("imports");
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
    if (!file) return setMsg({ kind: "err", text: t("chooseFile") });
    if (needsLayer(kind) && !layerId)
      return setMsg({ kind: "err", text: t("chooseLayer") });
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
        text: e instanceof Error ? e.message : t("uploadFailed"),
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
    setMsg({ kind: "ok", text: t("importQueued") });
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
            {t("newImport")}
          </button>
        )}
        <div className="flex-1" />
        <button className="cmc-btn" onClick={refresh}>
          {t("refresh")}
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
              <span className="cmc-label">{t("type")}</span>
              <select
                className="cmc-input"
                style={{ width: 230 }}
                value={kind}
                onChange={(e) => setKind(e.target.value as ImportKind)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {t(k.labelKey)}
                  </option>
                ))}
              </select>
            </label>

            {needsLayer(kind) && (
              <label className="flex flex-col gap-1">
                <span className="cmc-label">{t("targetLayer")}</span>
                <select
                  className="cmc-input"
                  style={{ width: 200 }}
                  value={layerId}
                  onChange={(e) => setLayerId(e.target.value)}
                >
                  <option value="">{t("selectPlaceholder")}</option>
                  {layers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="cmc-label">{t("file")}</span>
              <input
                key={fileKey}
                type="file"
                className="text-[12px]"
                accept={KINDS.find((k) => k.value === kind)?.accept}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <button className="cmc-btn" onClick={submit} disabled={busy}>
              {busy ? t("uploading") : t("startImport")}
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
              {t("cancel")}
            </button>
          </div>
          {needsLayer(kind) && layers.length === 0 && (
            <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
              {t("noLayersHint")}
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
            {t("noImports")}
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
                <th className="px-4 py-2 font-medium">{t("thType")}</th>
                <th className="px-4 py-2 font-medium">{t("thStatus")}</th>
                <th className="px-4 py-2 font-medium">{t("thInserted")}</th>
                <th className="px-4 py-2 font-medium">{t("thQuarantined")}</th>
                <th className="px-4 py-2 font-medium">{t("thCreated")}</th>
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
  const t = useTranslations("imports");
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
          <FormattedDate value={job.createdAt} />
        </td>
        <td className="px-4 py-2.5 text-right">
          {job.failedRows > 0 && (
            <button
              className="text-[11px] hover:underline"
              style={{ color: "var(--c-accent)" }}
              onClick={onToggle}
            >
              {open ? t("hide") : t("viewErrors", { count: job.failedRows })}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="px-4 py-2" style={{ background: "var(--c-bg-2)" }}>
            {!errors ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("loading")}
              </div>
            ) : errors.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("noQuarantined")}
              </div>
            ) : (
              <ul className="flex flex-col gap-1 py-1">
                {errors.map((e, i) => (
                  <li key={i} className="text-[11px]" style={{ color: "var(--c-fg-2)" }}>
                    <span className="cmc-mono" style={{ color: "var(--c-sev-1)" }}>
                      {t("row", { num: e.rowNum })}
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
