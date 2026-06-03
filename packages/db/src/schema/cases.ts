import {
  pgTable,
  uuid,
  varchar,
  text,
  smallint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";
import { regions } from "./regions";

/**
 * Cases (P2.10 / ADR-0040) — the second operational domain module after
 * incidents. A case is a tracked unit of work (investigation, request, task)
 * with a lifecycle state machine (open → triage → in_progress → resolved →
 * closed, + cancelled), a priority (1..5, 1 = highest), an optional SLA target
 * (`due_at`), and an assignee. Its history lives in `case_activity`. `type` is
 * free text (config-driven case types are a follow-on). Tenant-isolated via RLS;
 * soft-deleted via `deleted_at`.
 */
export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 300 }).notNull(),
    description: text("description"),
    /** Free-text category (config-driven types are a follow-on). */
    type: varchar("type", { length: 80 }).notNull(),
    /** 1..5, 1 = highest priority. CHECK enforced in the migration. */
    priority: smallint("priority").notNull().default(3),
    /** Lifecycle state — one of CASE_STATUSES. */
    status: varchar("status", { length: 20 }).notNull().default("open"),
    /**
     * Structured region for access scoping (P4.6); NULL = unassigned / head-
     * office pool. Visibility is enforced in the service layer (`region:all`
     * sees all).
     */
    regionId: uuid("region_id").references(() => regions.id, {
      onDelete: "set null",
    }),

    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    openedBy: uuid("opened_by").references(() => users.id, {
      onDelete: "set null",
    }),

    /** SLA target; escalation cron is a follow-on (Temporal, P3.1). */
    dueAt: timestamp("due_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("cases_tenant_idx").on(t.tenantId),
    statusIdx: index("cases_status_idx").on(t.tenantId, t.status),
    regionIdx: index("cases_region_idx").on(t.tenantId, t.regionId),
    assignedIdx: index("cases_assigned_idx").on(t.assignedTo),
    dueIdx: index("cases_due_idx").on(t.dueAt),
    // Full-text search (P2.11 / ADR-0041).
    ftsIdx: index("cases_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.description}, '') || ' ' || coalesce(${t.type}, ''))`,
    ),
  }),
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
