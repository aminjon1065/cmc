import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * GIS layers (P2.7 / ADR-0037) — the spatial plane's container: a named set of
 * features with a rendering `style` (MapLibre fragment) and a `schema` describing
 * the shape of each feature's `properties`. `kind` hints the geometry family
 * (point/line/polygon/mixed) for the UI; `sourceUri` records an external origin
 * when a layer is imported. `isPublic` is a forward-looking flag for tenant-wide
 * vs restricted visibility. Tenant-isolated via RLS; soft-deleted via `deleted_at`.
 */
export const gisLayers = pgTable(
  "gis_layers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 160 }).notNull(),
    /** point | line | polygon | mixed (UI hint; geometry itself is generic). */
    kind: varchar("kind", { length: 20 }).notNull().default("mixed"),
    /** MapLibre style fragment for rendering this layer. */
    style: jsonb("style").notNull().default({}),
    /** JSON schema describing each feature's `properties`. */
    schema: jsonb("schema").notNull().default({}),
    /** External source (import URI), when applicable. */
    sourceUri: varchar("source_uri", { length: 500 }),
    isPublic: boolean("is_public").notNull().default(false),

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
    tenantIdx: index("gis_layers_tenant_idx").on(t.tenantId),
  }),
);

export type GisLayer = typeof gisLayers.$inferSelect;
export type NewGisLayer = typeof gisLayers.$inferInsert;
