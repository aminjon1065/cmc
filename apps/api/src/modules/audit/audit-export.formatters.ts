import { schema } from "@cmc/db";

export type AuditRow = typeof schema.auditLog.$inferSelect;

/**
 * SIEM line formatters for the audit export (P1.12 / ADR-0030).
 *
 * Two industry formats: RFC 5424 syslog and ArcSight CEF. Both carry the same
 * fields; pick per destination via `AUDIT_EXPORT_FORMAT`. The audit row `id` is
 * the stable event id every SIEM dedups on (export is at-least-once).
 */

const APP_NAME = "cmc-audit";
// Private Enterprise Number placeholder for the RFC 5424 SD-ID. Swap for a real
// IANA-registered PEN if/when CMC obtains one.
const SD_ID = "cmc@99999";

/** RFC 5424 numeric severity from the audit outcome (facility = 13, log audit). */
function rfcSeverity(outcome: string): number {
  if (outcome === "success") return 6; // info
  if (outcome === "denied") return 5; // notice
  return 4; // warning (failure)
}

/** CEF 0–10 severity from the audit outcome. */
function cefSeverity(outcome: string): number {
  if (outcome === "success") return 3;
  if (outcome === "denied") return 7;
  return 6; // failure
}

function escapeSdValue(value: string): string {
  // RFC 5424 §6.3.3 — escape `"`, `\`, and `]` inside PARAM-VALUE.
  return value.replace(/([\\\]"])/g, "\\$1");
}

function escapeCefHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function escapeCefExtValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\n/g, "\\n");
}

/** Build the `key="value"` pairs for RFC 5424 structured data, omitting empties. */
function sdParams(row: AuditRow): string {
  const pairs: Array<[string, string | null]> = [
    ["eid", row.id],
    ["seq", String(row.seq)],
    ["tenant", row.tenantId],
    ["actor", row.actorId],
    ["actorType", row.actorType],
    ["resource", row.resourceType],
    ["resourceId", row.resourceId],
    ["outcome", row.outcome],
    ["src", row.ip],
    ["requestId", row.requestId],
    ["traceId", row.traceId],
  ];
  return pairs
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}="${escapeSdValue(String(v))}"`)
    .join(" ");
}

function humanMsg(row: AuditRow): string {
  const resource = row.resourceId
    ? `${row.resourceType}/${row.resourceId}`
    : row.resourceType;
  return `${row.actorType} ${row.actorId ?? "-"} ${row.action} ${resource} -> ${row.outcome}`;
}

/** RFC 5424: `<PRI>1 TS HOST APP PROCID MSGID [SD] MSG`. */
export function formatRfc5424(row: AuditRow, hostname: string): string {
  const pri = 13 * 8 + rfcSeverity(row.outcome);
  const ts = row.occurredAt.toISOString();
  const msgId = row.action.replace(/\s+/g, "_").slice(0, 32);
  const sd = `[${SD_ID} ${sdParams(row)}]`;
  return `<${pri}>1 ${ts} ${hostname} ${APP_NAME} - ${msgId} ${sd} ${humanMsg(row)}`;
}

/** CEF: `CEF:0|Vendor|Product|Version|SigID|Name|Severity|Extension`. */
export function formatCef(row: AuditRow): string {
  const header = [
    "CEF:0",
    "CMC",
    "Platform",
    "1.0",
    escapeCefHeader(row.action),
    escapeCefHeader(row.action),
    String(cefSeverity(row.outcome)),
  ].join("|");

  const ext: Array<[string, string | null]> = [
    ["rt", String(row.occurredAt.getTime())],
    ["deviceExternalId", row.id],
    ["cn1Label", "seq"],
    ["cn1", String(row.seq)],
    ["suid", row.actorId],
    ["suser", row.actorType],
    ["act", row.action],
    ["outcome", row.outcome],
    ["src", row.ip],
    ["requestId", row.requestId],
    ["cs1Label", "traceId"],
    ["cs1", row.traceId],
    ["cs2Label", "tenantId"],
    ["cs2", row.tenantId],
  ];
  const extension = ext
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${escapeCefExtValue(String(v))}`)
    .join(" ");

  return `${header}|${extension}`;
}
