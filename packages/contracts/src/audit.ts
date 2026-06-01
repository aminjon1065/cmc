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

/** Audit → ClickHouse projection status (P2.2 / ADR-0034). */
export const AuditProjectionStatusResponseSchema = z.object({
  /** Whether ClickHouse is reachable (projection can run). */
  active: z.boolean(),
  /** Highest `audit_log.seq` already projected to ClickHouse. */
  cursorSeq: z.number().int(),
  /** Audit rows awaiting projection (`seq > cursor`). */
  pending: z.number().int(),
});
export type AuditProjectionStatusResponse = z.infer<
  typeof AuditProjectionStatusResponseSchema
>;

export const AuditProjectionFlushResponseSchema = z.object({
  /** Rows projected to ClickHouse by this flush. */
  projected: z.number().int(),
  cursorSeq: z.number().int(),
});
export type AuditProjectionFlushResponse = z.infer<
  typeof AuditProjectionFlushResponseSchema
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
