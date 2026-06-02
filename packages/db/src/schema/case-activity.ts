import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { cases } from "./cases";

/**
 * Case activity timeline (P2.10 / ADR-0040) — append-only history for a case:
 * system entries (`created`, `status_changed`, `assigned`) the service writes on
 * each state change, plus user `comment`/`note` entries. Tenant-isolated via RLS.
 */
export const caseActivity = pgTable(
  "case_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** created | status_changed | assigned | comment | note */
    kind: varchar("kind", { length: 30 }).notNull(),
    body: text("body"),
    metadata: jsonb("metadata").notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("case_activity_tenant_idx").on(t.tenantId),
    caseIdx: index("case_activity_case_idx").on(t.tenantId, t.caseId),
    createdIdx: index("case_activity_created_idx").on(t.createdAt),
  }),
);

export type CaseActivityRow = typeof caseActivity.$inferSelect;
export type NewCaseActivity = typeof caseActivity.$inferInsert;
