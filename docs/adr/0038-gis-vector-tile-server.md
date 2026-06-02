# ADR-0038: GIS vector tile server (MVT)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.8
**Depends on:** ADR-0037 (GIS substrate)

## Context

The GIS substrate (P2.7) stores layers + features. A web map (MapLibre, P2.9)
renders them as **vector tiles** (MVT) — small per-tile protobufs the client
fetches on demand. P2.8 serves them straight from PostGIS.

## Decision

A tile endpoint renders MVT in-database with `ST_AsMVT`, rather than running a
separate tile server (pg_tileserv/Martin) — one fewer moving part, and it
inherits the app's auth + RLS for free.

### Endpoint

`GET /v1/gis/tiles/:layerId/:z/:x/:y.mvt`, gated `gis_layer:read` (MapLibre
sends the bearer via its `transformRequest`). Binary response (`@Res`):
`Content-Type: application/vnd.mapbox-vector-tile`, `Cache-Control: private,
max-age=60` (tenant-scoped + auth'd → private; short TTL). An **empty tile is
`204`**; out-of-range `z/x/y` (z 0–24, x/y in `0..2^z-1`) is `400`.

### Query

```
WITH bounds AS (SELECT ST_TileEnvelope(z,x,y) AS merc)   -- Web Mercator (3857)
SELECT ST_AsMVT(t,'features',4096,'geom')
FROM (
  SELECT id, properties,
         ST_AsMVTGeom(ST_Transform(geometry,3857), bounds.merc, 4096,64,true)
  FROM gis_features, bounds
  WHERE layer_id = $layerId AND deleted_at IS NULL
    AND geometry && ST_Transform(bounds.merc, 4326)   -- GIST-indexed, in 4326
) t
```

The bbox filter runs in **WGS84 against the original geometry**, so it uses the
GIST index (ADR-0037); only matching rows are transformed to 3857 for
`ST_AsMVTGeom`. RLS confines the read to the caller's tenant — a cross-tenant or
unknown layer yields an empty tile (`204`), not an error, which is the right
behaviour for a map client.

## Consequences

**Positive**
- MapLibre-ready vector tiles with zero extra infrastructure; auth + RLS + audit
  posture inherited from the app.
- Index-using envelope filter (the `&&` stays in 4326); per-tile work bounded.
- Verified live: world tile `0/0/0` → 200, `application/vnd.mapbox-vector-tile`,
  86 bytes (a valid protobuf with a `features` layer); western `1/0/0` → 204;
  `2/9/0` → 400.

**Negative / deferred**
- **No tile cache / CDN** — every request hits Postgres (Cache-Control gives the
  browser a 60s TTL; a shared cache/`Cache-Tag` + CDN is a scale follow-on).
- **One layer per tile** (the URL names a single `layerId`); a multi-layer
  combined tile is a later option.
- **No signed-URL variant** (the plan's optional CDN-friendly mode) — bearer auth
  only for now.
- Reprojection per request (`ST_Transform` to 3857); fine at this scale.

## Validation

- **Suite**: 254/254, 32 suites. `gis` tile tests (4): non-empty world tile
  (200 + `mapbox-vector-tile` + content-length > 0 + Cache-Control), empty tile
  (204), out-of-range coords (400), RBAC (`gis_layer:read` → 403 without).
- **Live smoke** (booted API): `0/0/0.mvt` → 200 / 86-byte MVT (`features`
  layer); `1/0/0.mvt` → 204; `2/9/0.mvt` → 400.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration.
