# ADR-0037: GIS substrate (PostGIS layers + features)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.7
**Depends on:** ADR-0019 (RBAC, P1.1), the PostGIS-enabled Postgres image

## Context

P2.7 opens the spatial plane (ToR §3.4): tenant-scoped GIS **layers** (named sets
with a render `style` + a `properties` `schema`) and **features** (a geometry +
free-form properties). This is the substrate the tile server (P2.8) and the
MapLibre frontend (P2.9) build on.

## Decision

### PostGIS is already in the image — no infra switch

The dev image is `cmc/postgres:16-postgis-pgvector` with `postgis` already
installed. Migration 0018 just `CREATE EXTENSION IF NOT EXISTS postgis`
(idempotent; runs as the migration owner/superuser, so the test DB becomes
self-sufficient without a manual step).

### `geometry(Geometry, 4326)`, not `GeometryZ`

The plan sketched `geometry(GeometryZ, 4326)`, but a `GeometryZ` typmod **rejects
ordinary 2D GeoJSON** ("Column has Z dimension but geometry does not") — and 2D
is the common case. The column is `geometry(Geometry, 4326)`: any geometry type,
2D or 3D, WGS84. (Verified: a 2D point round-trips faithfully.)

### GeoJSON on the wire, PostGIS in the column

Geometry crosses the API as GeoJSON. The service writes it with
`ST_SetSRID(ST_GeomFromGeoJSON($json), 4326)` and reads it with `ST_AsGeoJSON`,
in raw SQL inside the request's tenant tx. The shape is structurally validated
against a Zod GeoJSON schema first (clean `400`), then PostGIS validates the
coordinates. Layers are plain Drizzle rows; `featureCount` is a **separate
grouped count** (a correlated subquery embedded in a Drizzle `.select()`
projection did not correlate reliably).

### Tenant isolation + spatial index + bbox

Both tables enforce **RLS** (the two-GUC pattern) — a cross-tenant id is a clean
miss (→ 404). `gis_features.geometry` has a **GIST** index; the bbox list filters
with `geometry && ST_MakeEnvelope(minLng,minLat,maxLng,maxLat,4326)` (index-using
overlap). A malformed bbox is a `400`.

### RBAC: sub-resource in the domain

Permissions are `gis_layer:read`, `gis_layer:edit`, `gis_feature:write`. Keys are
`${domain}:${action}` split on a **single** colon throughout the platform, so the
sub-resource lives in the **domain** (`gis_layer`/`gis_feature`) rather than the
action — a `gis:layer:edit` form would mis-parse (action `layer`) and silently
drop the grant. Operator gets read + feature:write; auditor read; tenant_admin
all (`*`).

## Consequences

**Positive**
- First spatial domain end-to-end: layer + feature CRUD, GeoJSON round-trip,
  GIST-indexed bbox queries, tenant-isolated + audited. Substrate ready for the
  tile server (P2.8) + map UI (P2.9).
- No infra change (PostGIS already present); one migration (0018); reuses the
  service/controller/RLS/audit conventions.
- Verified live (booted API): layer → feature (`Point [68.78,38.56]` round-trip)
  → bbox near = 1 / far = 0 → featureCount = 1.

**Negative / deferred**
- **No domain events** for GIS yet (audit only) — realtime map updates are a
  later concern.
- Geometry validation surfaces deep PostGIS errors as `400` via a try/catch; a
  malformed-but-structurally-valid geometry that PostGIS rejects rolls the
  request tx back (rare).
- `style`/`schema`/`properties` are free-form `jsonb` (no server-side schema
  enforcement on properties yet).
- Single-DB PostGIS; no tiling cache (P2.8), no import/export (GeoPackage/Shp).

## Validation

- **Suite**: 250/250, 32 suites. `gis` (6): layer CRUD; feature CRUD + GeoJSON
  round-trip; bbox GIST filter (near/far); malformed bbox + invalid GeoJSON →
  400; RBAC (edit vs write vs read, incl. operator/role-less); tenant isolation
  (RLS).
- **Live smoke** (booted API, real PostGIS, seed data): create layer → feature
  (geometry round-trips exactly) → bbox near=1/far=0 → featureCount=1.
- **Migration**: 0018 (extension + tables + GIST + tenant/layer indexes + RLS)
  applied to dev + `cmc_test`; column `geometry(Geometry, 4326)`.
- **Build/lint**: API `tsc` + `nest build` + `eslint` + db build clean.
