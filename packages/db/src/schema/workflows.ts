import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Visual workflow definitions (P3.8 / ADR-0053). A workflow is a directed
 * acyclic graph authored in the web builder and stored as data — `definition`
 * holds `{ nodes, edges }`. It is executed by a single generic interpreter
 * Temporal workflow (P3.8b), so adding/editing a workflow never needs a worker
 * redeploy. `version` bumps on every definition change; `enabled` gates running
 * + event triggers. `trigger_type`/`trigger_event` bind an optional auto-start
 * on a domain event subject (P3.8c). Tenant-isolated via RLS; soft-deleted.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),

    /** Graph `{ nodes: [...], edges: [...] }`; validated as a DAG at write time. */
    definition: jsonb("definition")
      .notNull()
      .default(sql`'{"nodes":[],"edges":[]}'::jsonb`),

    /** Bumped on every definition update (optimistic display / run pinning). */
    version: integer("version").notNull().default(1),
    /** Gates manual runs + event triggers. */
    enabled: boolean("enabled").notNull().default(false),

    /** 'manual' | 'event' — CHECK enforced in the migration. */
    triggerType: varchar("trigger_type", { length: 20 })
      .notNull()
      .default("manual"),
    /** Event subject to auto-start on (e.g. 'incident.created') when type='event'. */
    triggerEvent: varchar("trigger_event", { length: 120 }),

    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("workflows_tenant_idx").on(t.tenantId),
    // Find enabled event-triggered workflows by subject (P3.8c).
    triggerIdx: index("workflows_trigger_idx").on(
      t.tenantId,
      t.triggerType,
      t.triggerEvent,
    ),
  }),
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
