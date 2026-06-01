import { pgTable, smallint, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row cursor for the SIEM audit export worker (P1.12 / ADR-0030).
 *
 * Tracks the highest `audit_log.seq` already shipped to the SIEM, so the worker
 * resumes after a restart without re-exporting the whole log (and without gaps).
 * Platform-internal (no tenant, no RLS) — only the privileged export worker
 * touches it. `id` is pinned to 1 (one row).
 */
export const auditExportCursor = pgTable("audit_export_cursor", {
  id: smallint("id").primaryKey().default(1),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AuditExportCursor = typeof auditExportCursor.$inferSelect;
