import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { gisLayers } from "./gis-layers";

/**
 * A PostGIS geometry column, `geometry(GeometryZ, 4326)` — any geometry type,
 * 3D-aware (Z), in WGS84. We read/write it through PostGIS functions
 * (`ST_GeomFromGeoJSON` / `ST_AsGeoJSON`) in the service, so the Drizzle type is
 * only used for DDL generation; selecting it directly would yield EWKB hex.
 */
const geometryZ = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(GeometryZ, 4326)";
  },
});

/**
 * GIS features (P2.7 / ADR-0037) — one geometry + free-form `properties` within
 * a layer. Geometry is WGS84 (SRID 4326). Spatially indexed (GIST) for
 * bbox/tile queries; tenant-isolated via RLS; soft-deleted via `deleted_at`.
 */
export const gisFeatures = pgTable(
  "gis_features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    layerId: uuid("layer_id")
      .notNull()
      .references(() => gisLayers.id, { onDelete: "cascade" }),

    geom: geometryZ("geometry").notNull(),
    properties: jsonb("properties").notNull().default({}),

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
    tenantIdx: index("gis_features_tenant_idx").on(t.tenantId),
    layerIdx: index("gis_features_layer_idx").on(t.tenantId, t.layerId),
    // Spatial index for bbox / tile envelope queries.
    geomIdx: index("gis_features_geom_idx").using("gist", t.geom),
  }),
);

export type GisFeature = typeof gisFeatures.$inferSelect;
export type NewGisFeature = typeof gisFeatures.$inferInsert;
