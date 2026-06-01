import { pgTable, varchar, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Cursor ledger for tail-reading projections (P2.2 / ADR-0034).
 *
 * Generic over the consumer name, so each cursor-based projection (audit →
 * ClickHouse, and future ones) tracks its own `last_seq` position over a source
 * `seq` stream — resuming after restart without gaps. Platform-internal (no
 * tenant, no RLS).
 */
export const projectionCursors = pgTable("projection_cursors", {
  /** Logical consumer name, e.g. `audit-clickhouse`. */
  consumer: varchar("consumer", { length: 64 }).primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectionCursor = typeof projectionCursors.$inferSelect;
