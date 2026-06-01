"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  INCIDENT_TRANSITIONS,
  RESOLVING_STATUSES,
  type IncidentDetail,
} from "@cmc/contracts";
import { STATUS_LABEL } from "@/components/cmc/incident-badges";
import {
  REGION_SUGGESTIONS,
  TYPE_SUGGESTIONS,
  SOURCE_SUGGESTIONS,
} from "@/lib/incident-suggestions";
import {
  assignIncidentAction,
  deleteIncidentAction,
  transitionIncidentAction,
  updateIncidentAction,
} from "../actions";

type Assignee = { id: string; name: string };
type Res = { ok: true; data: unknown } | { ok: false; error: string };

function toLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function IncidentActions({
  incident,
  canWrite,
  canResolve,
  canAssign,
  canDelete,
  assignees,
}: {
  incident: IncidentDetail;
  canWrite: boolean;
  canResolve: boolean;
  canAssign: boolean;
  canDelete: boolean;
  assignees: Assignee[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Only states reachable from the current status; resolving states hidden
  // when the user lacks incident:resolve (the API would 403 anyway).
  const reachable = (INCIDENT_TRANSITIONS[incident.status] ?? []).filter(
    (s) => canResolve || !RESOLVING_STATUSES.includes(s),
  );

  async function run(p: Promise<Res>) {
    setBusy(true);
    setError(null);
    const res = await p;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  async function onDelete() {
    if (!confirm("Delete this incident? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    const res = await deleteIncidentAction(incident.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.push("/incidents");
  }

  return (
    <div className="flex flex-col gap-4">
      {canWrite && reachable.length > 0 && (
        <div>
          <div className="cmc-label mb-1.5">Advance status</div>
          <div className="flex flex-wrap gap-1.5">
            {reachable.map((s) => (
              <button
                key={s}
                type="button"
                className="cmc-btn"
                disabled={busy}
                onClick={() => run(transitionIncidentAction(incident.id, s))}
              >
                → {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      )}

      {canAssign && (
        <div>
          <div className="cmc-label mb-1.5">Assignee</div>
          <select
            className="cmc-input"
            style={{ width: "100%" }}
            disabled={busy}
            value={incident.assignedTo?.id ?? ""}
            onChange={(e) =>
              run(assignIncidentAction(incident.id, e.target.value || null))
            }
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {canWrite && (
          <button
            type="button"
            className="cmc-btn"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close edit" : "Edit fields"}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="cmc-btn"
            style={{ color: "var(--c-sev-1)" }}
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </button>
        )}
      </div>

      {editing && canWrite && (
        <EditForm
          incident={incident}
          onDone={() => {
            setEditing(false);
            router.refresh();
          }}
          onError={setError}
        />
      )}

      {error && (
        <div className="text-[11px]" style={{ color: "var(--c-sev-1)" }} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function EditForm({
  incident,
  onDone,
  onError,
}: {
  incident: IncidentDetail;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [severity, setSeverity] = useState(incident.severity);
  const [type, setType] = useState(incident.type);
  const [region, setRegion] = useState(incident.region);
  const [source, setSource] = useState(incident.source ?? "");
  const [summary, setSummary] = useState(incident.summary);
  const [description, setDescription] = useState(incident.description ?? "");
  const [occurredAt, setOccurredAt] = useState(toLocal(incident.occurredAt));
  const [latitude, setLatitude] = useState(
    incident.latitude != null ? String(incident.latitude) : "",
  );
  const [longitude, setLongitude] = useState(
    incident.longitude != null ? String(incident.longitude) : "",
  );
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await updateIncidentAction(incident.id, {
      severity,
      type,
      region,
      source: source.trim() || null,
      summary,
      description: description.trim() || null,
      occurredAt: new Date(occurredAt).toISOString(),
      latitude: latitude.trim() === "" ? null : Number(latitude),
      longitude: longitude.trim() === "" ? null : Number(longitude),
    });
    setBusy(false);
    if (!res.ok) {
      onError(res.error);
      return;
    }
    onDone();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-2.5 rounded-md p-3"
      style={{ background: "var(--c-bg-2)", border: "0.5px solid var(--c-line-2)" }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Severity</span>
          <select
            className="cmc-input"
            style={{ width: 80 }}
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
            style={{ width: 130 }}
            list="edit-types"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <datalist id="edit-types">
            {TYPE_SUGGESTIONS.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Region</span>
          <input
            className="cmc-input"
            style={{ width: 130 }}
            list="edit-regions"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          />
          <datalist id="edit-regions">
            {REGION_SUGGESTIONS.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Source</span>
          <input
            className="cmc-input"
            style={{ width: 110 }}
            list="edit-sources"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <datalist id="edit-sources">
            {SOURCE_SUGGESTIONS.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="cmc-label">Summary</span>
        <input
          className="cmc-input"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={300}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="cmc-label">Description</span>
        <textarea
          className="cmc-input"
          style={{ height: 56, paddingTop: 6 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Occurred at</span>
          <input
            className="cmc-input"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Lat</span>
          <input
            className="cmc-input"
            style={{ width: 110 }}
            inputMode="decimal"
            value={latitude}
            onChange={(e) => setLatitude(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Lng</span>
          <input
            className="cmc-input"
            style={{ width: 110 }}
            inputMode="decimal"
            value={longitude}
            onChange={(e) => setLongitude(e.target.value)}
          />
        </label>
        <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
