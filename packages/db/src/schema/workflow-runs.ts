import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";
import { workflows } from "./workflows";

/**
 * Workflow executions (P3.8b / ADR-0053). One row per run of a workflow's
 * interpreter Temporal execution. The graph is snapshotted into `definition` at
 * start, so editing the workflow later never changes a past run's behaviour, and
 * the interpreter receives the snapshot as its argument. `status` is driven by
 * the interpreter via activities (pending → running → completed/failed).
 * Tenant-isolated via RLS.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** The workflow `version` at run time (the snapshot's version). */
    workflowVersion: integer("workflow_version").notNull(),
    /** Immutable snapshot of the graph executed by this run. */
    definition: jsonb("definition").notNull(),

    /** pending | running | completed | failed — CHECK enforced in the migration. */
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    /** 'manual' | 'event' — how the run was started. */
    trigger: varchar("trigger", { length: 20 }).notNull().default("manual"),

    input: jsonb("input").notNull().default(sql`'{}'::jsonb`),
    /** Final interpreter context / result (set on completion). */
    output: jsonb("output"),
    error: text("error"),

    /** The Temporal workflow execution id (for correlation), if started. */
    temporalWorkflowId: varchar("temporal_workflow_id", { length: 200 }),
    /** Initiator; null for event-triggered / system runs (P3.8c). */
    startedBy: uuid("started_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("workflow_runs_tenant_idx").on(t.tenantId),
    workflowIdx: index("workflow_runs_workflow_idx").on(
      t.tenantId,
      t.workflowId,
    ),
    statusIdx: index("workflow_runs_status_idx").on(t.tenantId, t.status),
  }),
);

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
