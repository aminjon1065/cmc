import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  inet,
} from "drizzle-orm/pg-core";

/**
 * Append-only audit log. Per ToR §3.15, the table is treated as immutable —
 * the application service writes only INSERTs; UPDATE/DELETE is denied via
 * a database role at deployment time.
 *
 * Tamper-evidence (hash chaining) is added in a later phase. The columns are
 * here from day one so the log can be backfilled without schema migrations.
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
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
