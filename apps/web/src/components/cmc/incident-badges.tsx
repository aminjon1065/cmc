"use client";

import type { IncidentStatus } from "@cmc/contracts";
import { useTranslations } from "next-intl";

/** Presentational severity/status chips, shared by list + detail (P1.5b).
 *  Status labels are localized (RU/TG) via the `incidents.status.*` catalog. */

const STATUS_COLORS: Record<IncidentStatus, { fg: string; bg: string }> = {
  reported: { fg: "var(--c-sev-2)", bg: "var(--c-sev-2-soft)" },
  triaged: { fg: "var(--c-info)", bg: "var(--c-info-soft)" },
  in_progress: { fg: "var(--c-accent)", bg: "var(--c-accent-soft)" },
  resolved: { fg: "var(--c-ok)", bg: "var(--c-ok-soft)" },
  closed: { fg: "var(--c-fg-3)", bg: "var(--c-bg-3)" },
  cancelled: { fg: "var(--c-fg-4)", bg: "var(--c-bg-3)" },
};

export function StatusBadge({ status }: { status: IncidentStatus }) {
  const t = useTranslations("incidents");
  const m = STATUS_COLORS[status] ?? STATUS_COLORS.reported;
  return (
    <span
      className="cmc-chip"
      style={{ color: m.fg, background: m.bg, borderColor: "transparent" }}
    >
      {t(`status.${status}`)}
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
