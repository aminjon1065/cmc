# ADR-0079: GeoServer for GIS interop (QGIS / ArcGIS / web over one PostGIS)

**Status:** Accepted (Phase 3 — web consumes GeoServer WMS)
**Date:** 2026-06-06
**Depends on:** ADR-0037 (GIS substrate / PostGIS), ADR-0039 (MapLibre web map)

## Context

The web map (ADR-0039) renders the tenant's GIS data via the API's MVT tile
server. The operator needs the **same** GIS data to be first-class in desktop
GIS tools — **QGIS and ArcGIS Pro** — for authoring/analysis, while the web app
keeps working. That means exposing PostGIS over **standard OGC services** both
desktop clients consume natively.

Options considered: GeoServer (full OGC: WMS/WFS/WMTS/SLD); OGC API Features on
our own NestJS (integrated auth/RLS/audit, but no rendered WMS, weaker on older
ArcGIS); pg_tileserv + pg_featureserv (lightweight, weaker ArcGIS); direct
PostGIS connection (simple but exposes the DB to desktops). The operator chose
**GeoServer** — it guarantees both QGIS *and* ArcGIS connect, which the others
don't all do.

## Decision

Run **GeoServer** as an infra service over the existing PostGIS, read-only:

- **Source of truth stays PostGIS.** GeoServer only reads + serves it.
- **Least-privilege DB access:** a dedicated `geoserver_ro` role —
  `LOGIN NOSUPERUSER ... BYPASSRLS`, `SELECT` only on `gis_features`/`gis_layers`.
  `BYPASSRLS` is needed because RLS is `FORCE`d on those tables; for a
  **single-site** deployment (one tenant) reading all GIS rows is the intended
  scope. GeoServer never gets the superuser/owner role.
- **Compose service** `geoserver` (`docker.osgeo.org/geoserver:2.26.1`) on
  `cmc-net`, persistent `geoserver_data` volume, healthcheck, admin password via
  `GEOSERVER_ADMIN_PASSWORD`. Reaches the DB as host `postgres`.
- **Config is reproducible:** role in `infra/postgres/init/02-roles.sql`;
  workspace + PostGIS datastore + published layer via the idempotent
  `infra/geoserver/setup.sh` (GeoServer REST API).
- **Clients:** QGIS/ArcGIS connect to `…/geoserver/cmc/{wms,wfs}`; the web app
  consumes WMS via a same-origin BFF proxy (see below). Connection steps in
  `infra/geoserver/README.md`.
- **Per-layer layers + style (Phase 2):** `setup.sh` publishes one named layer
  per `gis_layers` row — a `JDBC_VIRTUAL_TABLE` SQL view filtered by `layer_id`
  + `deleted_at IS NULL`, slug-named (e.g. `cmc:flood_zones`) — so each thematic
  layer is a first-class, separately-queryable OGC layer. A single `cmc_default`
  SLD (`infra/geoserver/styles/cmc_default.sld`: point/line/polygon in accent
  `#2f6fe0`) is the default style on every layer.
- **Web integration (Phase 3):** MapLibre adds each layer as a **WMS raster**
  source whose tiles come from a **same-origin BFF proxy** (`/api/gis/wms`,
  NextAuth-gated, SSRF-safe: fixed GeoServer host+path, allow-listed WMS params).
  The browser never reaches GeoServer directly; the web shows the *same*
  server-rendered, SLD-styled layers as QGIS/ArcGIS. Clicks issue WMS
  **GetFeatureInfo** through the same proxy → the feature inspector. Source is
  switchable via `NEXT_PUBLIC_GIS_SOURCE` (`geoserver` default | `mvt` fallback);
  the basemap is independent, so a GeoServer outage degrades to "basemap only",
  never a blank map.

## Consequences

**Positive**
- One GIS source, three consumers (QGIS, ArcGIS Pro, web) over open standards.
- Read-only least-privilege role; superuser/owner never exposed to GeoServer.
- Self-hosted → airgap-friendly; config reproducible from scripts.

**Negative / deferred**
- GeoServer has its **own** auth + styling (SLD), separate from the platform
  RBAC/i18n — front it with Caddy + real creds in prod.
- It **bypasses** the platform's RLS/permissions/audit (reads PostGIS directly).
  Acceptable read-only single-site; multi-tenant needs per-tenant SQL views.
- The `amd64` image runs under emulation on Apple Silicon (slower boot).
- Editing (WFS-T) intentionally off (read-only); desktop edits should ideally
  route through the API to preserve RBAC + audit.
- Heavier than the alternatives (Java/Tomcat) — accepted for guaranteed ArcGIS
  + QGIS interop.

## Validation (Phase 1)

- `cmc-geoserver` healthy; REST `/about/version` → 200 (admin auth).
- `setup.sh`: workspace `cmc` + PostGIS datastore (via `geoserver_ro`) + layer
  `cmc:gis_features` all created (201).
- **WFS** GetFeature → real GeoJSON (`Point [68.78, 38.56] "Dushanbe HQ"` with
  properties); **WMS** GetMap → 200 `image/png`; **WMS+WFS GetCapabilities** → 200.
- `geoserver_ro` reads the GIS rows (BYPASSRLS) but is SELECT-only.

## Validation (Phase 2 — per-layer layers + SLD)

- `setup.sh` (idempotent): `cmc_default` style created; per-layer layers
  `cmc:flood_zones` + `cmc:tiles_smoke` published, each set to the default style.
- **WFS** GetFeature on `cmc:tiles_smoke` → `numberMatched=1` (the SQL view
  returns only that layer's features); **WMS** GetMap with `cmc:cmc_default` →
  200 `image/png` (2.4 KB, styled point drawn); both layers advertised in
  WMS + WFS GetCapabilities with their titles.

## Validation (Phase 3 — web)

- `tsc` / `eslint` / `next build` clean; `/api/gis/wms` route registered.
- In a live browser (logged-in `/map`, 1440×900): map canvas 1220×796 with the
  CARTO basemap; MapLibre issued **48 GetMap requests** through `/api/gis/wms`.
- BFF probes from the page (carrying the session cookie): WMS **GetMap** → 200
  `image/png` (2438 B); WMS **GetFeatureInfo** → 200 `application/json`.
- GetFeatureInfo over the feature → 1 feature, id `tiles_smoke.fid-…` (prefix →
  layer name) with its properties → drives the inspector.
- MVT fallback (`NEXT_PUBLIC_GIS_SOURCE=mvt`) and the basemap are untouched.

## Remaining (next phases)

1. **Caddy** front + auth hardening + `PROXY_BASE_URL`; prod creds (don't expose
   GeoServer publicly — only via the BFF / Caddy).
2. Operator **runbook** for QGIS/ArcGIS (started in the README).
3. Load **real layers/data** in place of the smoke layers; optional per-layer
   SLDs (distinct colours) instead of the single `cmc_default`.
4. (Deferred) editing / WFS-T — route writes through the API to keep RBAC+audit.
