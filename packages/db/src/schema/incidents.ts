import {
  pgTable,
  uuid,
  varchar,
  text,
  smallint,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Incidents (P1.5 / ADR-0023) — the first operational domain module.
 *
 * Severity is 1..5 (1 = most severe, rendered "SEV-1"). Status follows a
 * lifecycle state machine (reported → triaged → in_progress → resolved →
 * closed, + cancelled); transitions are validated in the service against the
 * shared `INCIDENT_TRANSITIONS` map. `region`/`type`/`source` are free text
 * (no jurisdiction-specific enum baked into the schema — the same principle as
 * branding, P0.11). Geolocation is optional lat/lng for a map pin; full
 * PostGIS geometry belongs to the GIS module (ToR §3.4). Soft-deleted via
 * `deleted_at`. Tenant-isolated via RLS.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** 1..5, 1 = most severe (SEV-1). CHECK enforced in the migration. */
    severity: smallint("severity").notNull(),
    /** Lifecycle state — one of INCIDENT_STATUSES. */
    status: varchar("status", { length: 20 }).notNull().default("reported"),

    /** Free-text categoricals (web offers jurisdiction suggestions). */
    type: varchar("type", { length: 80 }).notNull(),
    region: varchar("region", { length: 120 }).notNull(),
    source: varchar("source", { length: 120 }),

    summary: varchar("summary", { length: 300 }).notNull(),
    description: text("description"),

    /** Optional map pin (WGS84). Full geometry → GIS module. */
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),

    /** When the incident actually occurred (may predate the report). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    reportedBy: uuid("reported_by").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("incidents_tenant_idx").on(t.tenantId),
    statusIdx: index("incidents_status_idx").on(t.tenantId, t.status),
    severityIdx: index("incidents_severity_idx").on(t.tenantId, t.severity),
    occurredIdx: index("incidents_occurred_idx").on(t.occurredAt),
    assignedIdx: index("incidents_assigned_idx").on(t.assignedTo),
  }),
);

export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
