import { z } from "zod";

/**
 * Audit-log hash chain contracts (P1.11 / ADR-0029).
 *
 * The chain is partitioned per `(tenant_id, occurred_at::date UTC)`. Verifying
 * a chain walks its rows in `seq` order and recomputes each `this_hash` from the
 * row content + the predecessor's hash; a mismatch pinpoints the first tampered
 * (or missing) row.
 */

/** Sentinel tenant scope for tenant-less events (e.g. failed logins). */
export const AUDIT_SYSTEM_SCOPE = "system" as const;

export const AuditChainVerifyResponseSchema = z.object({
  /** Tenant UUID, or `"system"` for the tenant-less chain. */
  tenantScope: z.string(),
  /** UTC day the chain covers, `YYYY-MM-DD`. */
  date: z.string(),
  /** Rows in the chain for that day (sealed + pending). */
  rowsChecked: z.number().int(),
  /** Rows whose hash has been computed. */
  sealedRows: z.number().int(),
  /** Rows still awaiting the sealer (NULL `this_hash`). */
  pendingRows: z.number().int(),
  /** True when every sealed row's hash links correctly. */
  valid: z.boolean(),
  /** `seq` of the first row that failed verification, else null. */
  brokenAtSeq: z.number().int().nullable(),
  /** Whether a daily Merkle anchor (P1.11b) exists for this chain. */
  anchored: z.boolean(),
  /** The anchored Merkle root, or null when not yet anchored. */
  anchorRoot: z.string().nullable(),
  /**
   * Whether the chain's CURRENT Merkle root still matches the immutable anchor.
   * null when not anchored. False ⇒ the day's rows changed after anchoring —
   * tamper that the per-row chain alone might not surface (e.g. whole-day swap).
   */
  rootMatches: z.boolean().nullable(),
  /** ISO timestamp the verification ran. */
  checkedAt: z.string(),
});
export type AuditChainVerifyResponse = z.infer<
  typeof AuditChainVerifyResponseSchema
>;

export const AUDIT_EXPORT_FORMATS = ["rfc5424", "cef"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

export const AuditExportStatusResponseSchema = z.object({
  /** Whether the background export interval is running. */
  enabled: z.boolean(),
  format: z.enum(AUDIT_EXPORT_FORMATS),
  /** Sink transport: noop | stdout | file | tcp. */
  transport: z.string(),
  /** Highest `audit_log.seq` already shipped to the SIEM. */
  cursorSeq: z.number().int(),
  /** Rows awaiting export (`seq > cursor`). */
  pending: z.number().int(),
  /** ISO time the cursor last advanced, or null. */
  updatedAt: z.string().nullable(),
});
export type AuditExportStatusResponse = z.infer<
  typeof AuditExportStatusResponseSchema
>;

export const AuditExportFlushResponseSchema = z.object({
  /** Rows shipped by this flush. */
  exported: z.number().int(),
  /** Cursor position after the flush. */
  cursorSeq: z.number().int(),
});
export type AuditExportFlushResponse = z.infer<
  typeof AuditExportFlushResponseSchema
>;

export const AuditAnchorResponseSchema = z.object({
  tenantScope: z.string(),
  date: z.string(),
  merkleRoot: z.string(),
  rowCount: z.number().int(),
  lastSeq: z.number().int(),
  objectBucket: z.string(),
  objectKey: z.string(),
  objectVersionId: z.string().nullable(),
  retainUntil: z.string().nullable(),
  anchoredAt: z.string(),
  /** True when the anchor already existed (the request was idempotent). */
  alreadyAnchored: z.boolean(),
});
export type AuditAnchorResponse = z.infer<typeof AuditAnchorResponseSchema>;

export const AuditSealResponseSchema = z.object({
  /** How many previously-pending rows were sealed by this run. */
  sealedRows: z.number().int(),
  /** How many distinct `(tenant, day)` chains were advanced. */
  chainsTouched: z.number().int(),
});
export type AuditSealResponse = z.infer<typeof AuditSealResponseSchema>;

/**
 * Anchor coverage for the caller's tenant over a recent window (P3.15). One row
 * per UTC day with sealed audit activity; `gaps` flags past days that have
 * sealed rows but NO Merkle anchor (evidence of a dropped/missing daily anchor).
 */
export const AuditAnchorStatusDaySchema = z.object({
  date: z.string(),
  sealedRows: z.number().int().nonnegative(),
  anchored: z.boolean(),
  merkleRoot: z.string().nullable(),
});
export type AuditAnchorStatusDay = z.infer<typeof AuditAnchorStatusDaySchema>;

export const AuditAnchorStatusResponseSchema = z.object({
  tenantScope: z.string(),
  days: z.array(AuditAnchorStatusDaySchema),
  /** Past UTC days (date strings) with sealed rows but no anchor — should be empty. */
  gaps: z.array(z.string()),
  checkedAt: z.string(),
});
export type AuditAnchorStatusResponse = z.infer<
  typeof AuditAnchorStatusResponseSchema
>;

// --- Audit log viewer (read-only list, gated `audit:read`) ---

/** Action outcomes recorded on every audit row. */
export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;

/** One displayable audit-log row — a safe subset (no raw chain hashes). */
export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  occurredAt: z.string(),
  actorId: z.string().uuid().nullable(),
  actorType: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  outcome: z.string(),
  requestId: z.string().nullable(),
  /** True once the hash-chain sealer has linked this row (tamper-evident). */
  sealed: z.boolean(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/** Filters + keyset pagination for `GET /v1/audit/log` (coerced from query). */
export const AuditLogQuerySchema = z.object({
  action: z.string().max(128).optional(),
  resourceType: z.string().max(64).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  /** Keyset cursor: return rows with `seq` strictly below this. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogListResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  /** `seq` to pass as `?before=` for the next (older) page; null when exhausted. */
  nextCursor: z.number().int().nullable(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
