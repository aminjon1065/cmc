import { z } from "zod";

/**
 * GIS contracts (P2.7 / ADR-0037) — the spatial plane. Geometry crosses the wire
 * as **GeoJSON** (WGS84 / SRID 4326); the API converts to/from PostGIS with
 * `ST_GeomFromGeoJSON` / `ST_AsGeoJSON`. Coordinates are validated structurally
 * by PostGIS on write, so the wire schema stays permissive on `coordinates`.
 */

export const GEOJSON_GEOMETRY_TYPES = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
] as const;

export const GeoJsonGeometrySchema = z.object({
  type: z.enum(GEOJSON_GEOMETRY_TYPES),
  coordinates: z.array(z.any()).optional(),
  geometries: z.array(z.any()).optional(),
});
export type GeoJsonGeometry = z.infer<typeof GeoJsonGeometrySchema>;

/** Geometry-family hint for the UI; the column itself is generic. */
export const GisLayerKindSchema = z.enum(["point", "line", "polygon", "mixed"]);
export type GisLayerKind = z.infer<typeof GisLayerKindSchema>;

// ---------- Layers ----------

export const GisLayerResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: GisLayerKindSchema,
  style: z.record(z.unknown()),
  schema: z.record(z.unknown()),
  sourceUri: z.string().nullable(),
  isPublic: z.boolean(),
  featureCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GisLayerResponse = z.infer<typeof GisLayerResponseSchema>;

export const GisLayersListResponseSchema = z.object({
  layers: z.array(GisLayerResponseSchema),
});
export type GisLayersListResponse = z.infer<typeof GisLayersListResponseSchema>;

export const CreateGisLayerRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: GisLayerKindSchema.optional(),
  style: z.record(z.unknown()).optional(),
  schema: z.record(z.unknown()).optional(),
  sourceUri: z.string().trim().max(500).optional(),
  isPublic: z.boolean().optional(),
});
export type CreateGisLayerRequest = z.infer<typeof CreateGisLayerRequestSchema>;

export const UpdateGisLayerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: GisLayerKindSchema,
    style: z.record(z.unknown()),
    schema: z.record(z.unknown()),
    sourceUri: z.string().trim().max(500).nullable(),
    isPublic: z.boolean(),
  })
  .partial();
export type UpdateGisLayerRequest = z.infer<typeof UpdateGisLayerRequestSchema>;

// ---------- Features ----------

export const GisFeatureResponseSchema = z.object({
  id: z.string().uuid(),
  layerId: z.string().uuid(),
  geometry: GeoJsonGeometrySchema,
  properties: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GisFeatureResponse = z.infer<typeof GisFeatureResponseSchema>;

export const GisFeaturesListResponseSchema = z.object({
  features: z.array(GisFeatureResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type GisFeaturesListResponse = z.infer<
  typeof GisFeaturesListResponseSchema
>;

export const CreateGisFeatureRequestSchema = z.object({
  geometry: GeoJsonGeometrySchema,
  properties: z.record(z.unknown()).optional(),
});
export type CreateGisFeatureRequest = z.infer<
  typeof CreateGisFeatureRequestSchema
>;

export const UpdateGisFeatureRequestSchema = z
  .object({
    geometry: GeoJsonGeometrySchema,
    properties: z.record(z.unknown()),
  })
  .partial();
export type UpdateGisFeatureRequest = z.infer<
  typeof UpdateGisFeatureRequestSchema
>;

/** `bbox` is `minLng,minLat,maxLng,maxLat` (WGS84) for envelope filtering. */
export const ListGisFeaturesQuerySchema = z.object({
  bbox: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type ListGisFeaturesQuery = z.infer<typeof ListGisFeaturesQuerySchema>;
