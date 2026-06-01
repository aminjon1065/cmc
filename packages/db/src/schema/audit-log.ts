import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  inet,
  bigserial,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Append-only audit log. Per ToR §3.15, the table is treated as immutable —
 * the application service writes only INSERTs; UPDATE/DELETE is denied via
 * RLS policies (`audit_log_no_update` / `audit_log_no_delete`, migration 0002).
 *
 * Tamper-EVIDENCE on top of append-only is the hash chain (P1.11 / ADR-0029):
 * `seq` gives each row a monotonic position; an async sealer fills
 * `prev_event_hash` + `this_hash` so each row is cryptographically bound to its
 * predecessor within a per-`(tenant_id, occurred_at::date)` chain. `sealed_at`
 * marks when a row's hash was computed (NULL = pending seal).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    actorId: uuid("actor_id"),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 128 }),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    ip: inet("ip"),
    userAgent: varchar("user_agent", { length: 512 }),
    requestId: varchar("request_id", { length: 64 }),
    traceId: varchar("trace_id", { length: 64 }),
    metadata: jsonb("metadata"),
    prevEventHash: varchar("prev_event_hash", { length: 128 }),
    thisHash: varchar("this_hash", { length: 128 }),
    /** Monotonic insert order — the deterministic order a chain is walked in. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    /** When the hash chain sealed this row. NULL ⇒ pending seal. */
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantOccurredIdx: index("audit_log_tenant_occurred_idx").on(
      t.tenantId,
      t.occurredAt,
    ),
    actorIdx: index("audit_log_actor_idx").on(t.actorId),
    resourceIdx: index("audit_log_resource_idx").on(
      t.resourceType,
      t.resourceId,
    ),
    // Walk a per-(tenant, day) chain in seq order.
    chainIdx: index("audit_log_chain_idx").on(
      t.tenantId,
      t.occurredAt,
      t.seq,
    ),
    // Let the sealer find pending rows cheaply (partial index, small set).
    unsealedIdx: index("audit_log_unsealed_idx")
      .on(t.seq)
      .where(sql`${t.thisHash} is null`),
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
