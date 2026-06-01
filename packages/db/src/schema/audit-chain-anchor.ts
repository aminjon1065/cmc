import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  timestamp,
  date,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Daily Merkle-root anchors for the audit hash chain (P1.11b / ADR-0029).
 *
 * Once a `(tenant_scope, chain_date)` chain is sealed and closed (the day has
 * passed), the cron computes the Merkle root of its `this_hash` leaves and
 * writes it BOTH here and to object storage under Object Lock (WORM). The
 * immutable object is the tamper-proof anchor; this row is the queryable index
 * + the recompute target. A missing anchor for a past day is itself evidence
 * (you can't silently drop a whole day).
 *
 * Append-only (RLS `*_no_update` / `*_no_delete`, like `audit_log`).
 */
export const auditChainAnchor = pgTable(
  "audit_chain_anchor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Tenant UUID, or the literal `system` for the tenant-less chain. */
    tenantScope: varchar("tenant_scope", { length: 64 }).notNull(),
    /** UTC day the chain covers (`YYYY-MM-DD`). */
    chainDate: date("chain_date").notNull(),
    /** Merkle root over the day's `this_hash` leaves, in seq order. */
    merkleRoot: varchar("merkle_root", { length: 128 }).notNull(),
    rowCount: integer("row_count").notNull(),
    /** Highest `seq` covered — pins exactly which rows the root attests. */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
    objectBucket: varchar("object_bucket", { length: 128 }).notNull(),
    objectKey: varchar("object_key", { length: 256 }).notNull(),
    /** Object-Lock version of the anchor object (versioning is on for lock buckets). */
    objectVersionId: varchar("object_version_id", { length: 128 }),
    /** When the WORM retention on the anchor object expires. */
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    anchoredAt: timestamp("anchored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scopeDateIdx: uniqueIndex("audit_chain_anchor_scope_date_idx").on(
      t.tenantScope,
      t.chainDate,
    ),
  }),
);

export type AuditChainAnchor = typeof auditChainAnchor.$inferSelect;
export type NewAuditChainAnchor = typeof auditChainAnchor.$inferInsert;
