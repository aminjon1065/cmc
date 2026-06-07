# GeoServer — OGC GIS server (ADR-0079)

GeoServer publishes the platform's PostGIS GIS tables as standard **OGC**
services (WMS / WFS / WMTS) so the **same GIS data** is usable from:

- **QGIS** (desktop) — WMS for display, WFS for vectors;
- **ArcGIS Pro** (desktop) — WMS/WFS server connections;
- the **web app** (MapLibre) — WMS via the same-origin BFF proxy `/api/gis/wms`
  (default; set `NEXT_PUBLIC_GIS_SOURCE=mvt` to fall back to the API MVT layer).

PostGIS stays the single source of truth. GeoServer is read-only here: it
connects with the least-privilege `geoserver_ro` role (SELECT-only on the GIS
tables, `BYPASSRLS` for the single site — see `infra/postgres/init/02-roles.sql`).

## Bring it up

```bash
pnpm infra:up                 # starts cmc-geoserver (compose service `geoserver`)
bash infra/geoserver/setup.sh # workspace + PostGIS datastore + publish layer (idempotent)
```

- Admin UI: <http://localhost:8088/geoserver/web/> (default `admin` /
  `cmc_dev_geoserver_admin_change_me` — override via `GEOSERVER_ADMIN_PASSWORD`).
- Note: the image is `linux/amd64`; on Apple Silicon it runs under emulation
  (works, slower first boot).

## Published layers & style

`setup.sh` publishes, in the `cmc` workspace:

- one **named layer per `gis_layers` row** (a SQL view filtered by `layer_id`),
  e.g. `cmc:flood_zones`, `cmc:tiles_smoke` — this is what you normally add;
- `cmc:gis_features` — all features in one layer (handy for a quick overview);
- the **`cmc_default`** SLD (points = circles, lines, polygons = filled) is the
  default style on every layer. Edit `styles/cmc_default.sld` + re-run `setup.sh`
  to restyle, or manage styles in the GeoServer UI.

Re-run `setup.sh` after adding/removing GIS layers to publish the new ones.

## Connect from QGIS

- **WMS** (view): Layer → Add WMS/WMTS Layer → New →
  URL `http://localhost:8088/geoserver/cmc/wms` → Connect → add the named layers
  (`Flood zones`, `Tiles smoke`, …) or `gis_features` for all.
- **WFS** (vectors / attributes): Layer → Add WFS Layer → New →
  URL `http://localhost:8088/geoserver/cmc/wfs` → Connect → add the layers.
- Or connect QGIS straight to **PostGIS** (Browser → PostgreSQL) if you need
  full editing — host `localhost`, port `5432`, db `cmc`.

## Connect from ArcGIS Pro

- Insert → Connections → Server → **New WMS/WFS Server** →
  WMS URL `http://localhost:8088/geoserver/cmc/wms` (or WFS
  `.../cmc/wfs`) → add layers from the `cmc` workspace.

## Connect from the web app

The web `/map` page consumes these layers automatically via the same-origin BFF
proxy `app/api/gis/wms` (NextAuth-gated; the browser never reaches GeoServer
directly). Control it with web env (`apps/web/.env`):

- `NEXT_PUBLIC_GIS_SOURCE=geoserver` (default) — WMS rasters from GeoServer;
  `=mvt` falls back to the API's vector tiles (no GeoServer needed).
- `GEOSERVER_URL` — how the **web server** reaches GeoServer (dev default
  `http://localhost:8088/geoserver`; in a container use the service name
  `http://geoserver:8080/geoserver`). Server-only — never sent to the browser.

## Production notes

- Front GeoServer with **Caddy** (e.g. `/geoserver`) + real admin creds + TLS;
  set `PROXY_BASE_URL` to the public path. Do **not** expose GeoServer's port
  publicly — the web reaches it server-side via the BFF; only QGIS/ArcGIS
  operators need direct (VPN/Caddy-gated) access.
- **Multi-tenant:** `geoserver_ro` + `BYPASSRLS` reads every tenant's GIS rows.
  For multi-tenant, replace the table grants with per-tenant SECURITY-DEFINER
  views (or parameterised SQL views) and drop `BYPASSRLS`.
- **Editing (WFS-T):** disabled here (read-only role). If desktop editing is
  needed, prefer routing writes through the platform API (keeps RBAC + audit),
  or add a separate write role with care.
- The published layer config lives in the `geoserver_data` volume (survives
  restarts); `setup.sh` re-creates it on a fresh volume.
