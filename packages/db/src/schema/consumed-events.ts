import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Consumer-side idempotency ledger (P2.4 / ADR-0032).
 *
 * The event bus is at-least-once, so a durable consumer can see the same event
 * twice (redelivery after a crash / lost ack). Before acting, a consumer
 * "claims" `(event_id, consumer)` here; a second claim conflicts and the
 * consumer skips — so handlers are idempotent. Keyed by consumer name so each
 * independent consumer processes every event exactly once. Platform-internal
 * (no tenant, no RLS).
 */
export const consumedEvents = pgTable(
  "consumed_events",
  {
    eventId: uuid("event_id").notNull(),
    /** Logical consumer name, e.g. `incident-notifications`. */
    consumer: varchar("consumer", { length: 64 }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.consumer] }),
  }),
);

export type ConsumedEvent = typeof consumedEvents.$inferSelect;
