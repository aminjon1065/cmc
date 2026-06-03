import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { importJobs } from "./import-jobs";

/**
 * Quarantined rows from a bulk import (P3.11 / ADR-0056). Each row that fails
 * validation (or the insert) is recorded here with its 1-based line number, a
 * human-readable reason, and the raw offending payload — so an operator can
 * fix + re-import without guessing. Tenant-isolated via RLS.
 */
export const importRowErrors = pgTable(
  "import_row_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    /** 1-based row/feature number in the source file. */
    rowNum: integer("row_num").notNull(),
    reason: text("reason").notNull(),
    /** The offending row payload, for re-import after a fix. */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    jobIdx: index("import_row_errors_job_idx").on(t.tenantId, t.jobId),
  }),
);

export type ImportRowError = typeof importRowErrors.$inferSelect;
export type NewImportRowError = typeof importRowErrors.$inferInsert;
