import {
  pgTable,
  uuid,
  varchar,
  integer,
  jsonb,
  timestamp,
  bigserial,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Transactional outbox (P2.1 / ADR-0031) — the event plane's durability seam.
 *
 * Producers INSERT an event here in the SAME transaction as the state-change
 * they're recording, so the event and the state can never diverge (no
 * dual-write). A separate relay polls unpublished rows (`published_at IS NULL`)
 * in `seq` order, publishes them to NATS JetStream, and stamps `published_at` —
 * at-least-once (the event `id` is the dedup key). `version` lets a payload
 * shape evolve; `causation_id` links an event to the one that caused it.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Tenant scope; NULL for platform/system events. */
    tenantId: uuid("tenant_id"),
    /** Aggregate the event is about, e.g. `incident`. (NATS subject token.) */
    aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 128 }).notNull(),
    /** Bare event verb, e.g. `created`. (NATS subject token — no dots.) */
    eventType: varchar("event_type", { length: 64 }).notNull(),
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the relay published this to NATS. NULL ⇒ pending. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    traceId: varchar("trace_id", { length: 64 }),
    /** The event id that caused this one (causation chain), if any. */
    causationId: uuid("causation_id"),
    /** Monotonic publish order for the relay. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => ({
    // The relay scans pending rows cheaply (partial index, small set).
    unpublishedIdx: index("outbox_unpublished_idx")
      .on(t.seq)
      .where(sql`${t.publishedAt} is null`),
    tenantIdx: index("outbox_tenant_idx").on(t.tenantId, t.occurredAt),
  }),
);

export type OutboxEvent = typeof outbox.$inferSelect;
export type NewOutboxEvent = typeof outbox.$inferInsert;
