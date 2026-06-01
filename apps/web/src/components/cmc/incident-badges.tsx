import type { IncidentStatus } from "@cmc/contracts";

/** Presentational severity/status chips, shared by list + detail (P1.5b). */

const STATUS_META: Record<
  IncidentStatus,
  { label: string; fg: string; bg: string }
> = {
  reported: { label: "Reported", fg: "var(--c-sev-2)", bg: "var(--c-sev-2-soft)" },
  triaged: { label: "Triaged", fg: "var(--c-info)", bg: "var(--c-info-soft)" },
  in_progress: {
    label: "In progress",
    fg: "var(--c-accent)",
    bg: "var(--c-accent-soft)",
  },
  resolved: { label: "Resolved", fg: "var(--c-ok)", bg: "var(--c-ok-soft)" },
  closed: { label: "Closed", fg: "var(--c-fg-3)", bg: "var(--c-bg-3)" },
  cancelled: { label: "Cancelled", fg: "var(--c-fg-4)", bg: "var(--c-bg-3)" },
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.reported;
  return (
    <span
      className="cmc-chip"
      style={{ color: m.fg, background: m.bg, borderColor: "transparent" }}
    >
      {m.label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: number }) {
  const cls =
    severity === 1
      ? "cmc-chip-sev1"
      : severity === 2
        ? "cmc-chip-sev2"
        : severity === 3
          ? "cmc-chip-sev3"
          : "cmc-chip-info";
  return (
    <span
      className={`cmc-chip ${cls}`}
      style={{ minWidth: 40, justifyContent: "center" }}
    >
      SEV-{severity}
    </span>
  );
}

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  reported: "Reported",
  triaged: "Triaged",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
  cancelled: "Cancelled",
};
