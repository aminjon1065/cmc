import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Bulk data-import jobs (P3.11 / ADR-0056). A job points at an already-uploaded
 * source object (`source_key` in the files bucket) and a `kind` that selects the
 * parser + target domain (`csv_incidents`, `geojson_gis`, …). The worker parses,
 * validates per-row, commits the valid rows, and quarantines the rest
 * (`import_row_errors`). Counts + status are denormalised here for cheap polling.
 * Tenant-isolated via RLS.
 */
export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Parser + target selector, e.g. `csv_incidents` | `geojson_gis`. */
    kind: text("kind").notNull(),
    /** Object key of the uploaded source file (in the files bucket). */
    sourceKey: text("source_key").notNull(),
    /** Optional target row id — e.g. the GIS layer for `geojson_gis`. */
    targetId: uuid("target_id"),
    /** `queued` | `processing` | `completed` | `failed`. */
    status: text("status").notNull().default("queued"),
    totalRows: integer("total_rows").notNull().default(0),
    insertedRows: integer("inserted_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    /** Whole-job failure reason (file missing, unparseable, etc.). */
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("import_jobs_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;
