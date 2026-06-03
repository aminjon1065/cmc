import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Regions (P4.6 / ADR-0064) — a logical division of users and operational data
 * WITHIN a tenant. The deployment is single-site (one server at the head
 * office, backups co-located; no cross-datacenter replication), so "region" is
 * an organizational/visibility dimension, not a physical DR boundary: regional
 * users see only their own region, the head office (`region:all`) sees every
 * region. Seeded per-tenant with the administrative regions of Tajikistan and
 * then admin-editable. Tenant-isolated via RLS; `code` is the stable per-tenant
 * key (UPPER_SNAKE), `name` is the human-facing label.
 */
export const regions = pgTable(
  "regions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable per-tenant key, e.g. `DUSHANBE`, `SUGHD`. */
    code: text("code").notNull(),
    /** Human-facing name, e.g. `Душанбе`. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantCodeUq: uniqueIndex("regions_tenant_code_uq").on(t.tenantId, t.code),
    tenantIdx: index("regions_tenant_idx").on(t.tenantId),
  }),
);

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
