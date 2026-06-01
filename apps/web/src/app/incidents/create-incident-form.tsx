"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  REGION_SUGGESTIONS,
  TYPE_SUGGESTIONS,
  SOURCE_SUGGESTIONS,
} from "@/lib/incident-suggestions";
import { createIncidentAction } from "./actions";

/** "YYYY-MM-DDTHH:mm" in local time for a datetime-local input default. */
function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function Datalist({ id, options }: { id: string; options: readonly string[] }) {
  return (
    <datalist id={id}>
      {options.map((o) => (
        <option key={o} value={o} />
      ))}
    </datalist>
  );
}

export function CreateIncidentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState(3);
  const [type, setType] = useState("");
  const [region, setRegion] = useState("");
  const [source, setSource] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocal());
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSeverity(3);
    setType("");
    setRegion("");
    setSource("");
    setSummary("");
    setDescription("");
    setOccurredAt(nowLocal());
    setLatitude("");
    setLongitude("");
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createIncidentAction({
      severity,
      type,
      region,
      source: source.trim() || undefined,
      summary,
      description: description.trim() || undefined,
      occurredAt: new Date(occurredAt).toISOString(),
      latitude: latitude.trim() === "" ? undefined : Number(latitude),
      longitude: longitude.trim() === "" ? undefined : Number(longitude),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    reset();
    setOpen(false);
    router.push(`/incidents/${res.data.id}`);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="cmc-btn cmc-btn-primary"
        onClick={() => setOpen(true)}
      >
        + Report incident
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Severity</span>
          <select
            className="cmc-input"
            style={{ width: 90 }}
            value={severity}
            onChange={(e) => setSeverity(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((s) => (
              <option key={s} value={s}>
                SEV-{s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Type</span>
          <input
            className="cmc-input"
            style={{ width: 160 }}
            list="incident-types"
            value={type}
            onChange={(e) => setType(e.target.value)}
            maxLength={80}
            required
          />
          <Datalist id="incident-types" options={TYPE_SUGGESTIONS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Region</span>
          <input
            className="cmc-input"
            style={{ width: 160 }}
            list="incident-regions"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            maxLength={120}
            required
          />
          <Datalist id="incident-regions" options={REGION_SUGGESTIONS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Source</span>
          <input
            className="cmc-input"
            style={{ width: 130 }}
            list="incident-sources"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            maxLength={120}
          />
          <Datalist id="incident-sources" options={SOURCE_SUGGESTIONS} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Occurred at</span>
          <input
            className="cmc-input"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            required
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="cmc-label">Summary</span>
        <input
          className="cmc-input"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Short headline"
          maxLength={300}
          required
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="cmc-label">Description</span>
        <textarea
          className="cmc-input"
          style={{ height: 64, paddingTop: 6 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={10000}
        />
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Latitude (optional)</span>
          <input
            className="cmc-input"
            style={{ width: 130 }}
            inputMode="decimal"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
            placeholder="37.8"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Longitude (optional)</span>
          <input
            className="cmc-input"
            style={{ width: 130 }}
            inputMode="decimal"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
            placeholder="68.7"
          />
        </label>
      </div>

      {error && (
        <div className="text-[11.5px]" style={{ color: "var(--c-sev-1)" }} role="alert">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
          {busy ? "Reporting…" : "Report incident"}
        </button>
        <button
          type="button"
          className="cmc-btn"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
