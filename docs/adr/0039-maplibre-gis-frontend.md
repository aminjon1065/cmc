# ADR-0039: MapLibre GIS frontend + BFF tile proxy

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.9
**Depends on:** ADR-0038 (MVT tile server), ADR-0037 (GIS substrate)

## Context

The API serves vector tiles (P2.8) + layer/feature data (P2.7). P2.9 is the
user-facing map: a `/map` page that renders the tenant's GIS layers with
MapLibre GL, with a layer toggle and a click-to-inspect panel.

## Decision

### Tiles through a BFF proxy — the token never reaches the browser

The web app's auth model keeps the API access token **server-side** (NextAuth
session; `authedApiFetch` attaches the bearer in server components/handlers). To
keep that invariant for map tiles — which the browser fetches directly — a Next
**route handler** `app/api/gis/tiles/[layerId]/[z]/[x]/[y]/route.ts` proxies
them: MapLibre fetches same-origin (so the session cookie rides along), the
handler reads the session via `auth()`, attaches the API bearer, and streams the
MVT back (`204`/binary passthrough). The browser never holds the token. The
alternative — exposing a bearer to client JS via MapLibre `transformRequest` —
was rejected (it leaks the token into the browser).

### MapLibre is client-only, dynamic-imported

`MapView` is a `"use client"` component; MapLibre is `import()`-ed **inside the
effect** so it never loads during SSR (it touches `window`). Each layer becomes a
vector source pointing at the proxy, rendered as **fill + line + circle** (one of
each per layer, geometry-type filtered) so any geometry shows. The CSS is
imported in the component.

### Configurable basemap (sovereign-safe default)

The base style is `NEXT_PUBLIC_MAP_STYLE_URL` if set, else a **minimal,
self-contained** style (a background — no external calls). For a real basemap,
point the env at a self-hosted style (or `demotiles.maplibre.org` in dev). This
avoids baking an external basemap dependency into a platform that may run
air-gapped. The map centers on Tajikistan.

### Toggle + inspector

A toggle panel flips per-layer visibility via `setLayoutProperty(...,
'visibility', ...)` across the layer's 3 render sublayers. A map click runs
`queryRenderedFeatures` over the GIS layers and opens a right-hand inspector with
the feature's layer, geometry type, and properties.

## Consequences

**Positive**
- The GIS chain is end-to-end usable: substrate → tiles → map UI, with layer
  control + feature inspection.
- **Security**: the API token stays server-side (BFF proxy) — same posture as the
  rest of the web app; tiles inherit the session.
- No external runtime dependency by default (self-contained basemap); a real
  basemap is one env var away.

**Negative / deferred**
- **Visual rendering is not machine-verified** — there's no browser in this
  environment. Verified: web `tsc` + production build (route/component/proxy
  compile) and the proxy's auth gate (unauth tile → `401`). A human should
  confirm the map draws after login.
- **No on-map editing** (draw/move features), **no clustering/heatmap**, no
  basemap shipped — all follow-ons.
- **No realtime layer updates** yet (the P2.3 WS plane could push feature
  changes to the map — a later hook).
- Tile proxy adds a hop (web → API); acceptable, and it enables the secure model.

## Validation

- **Build/types**: web `tsc` clean; `next build` succeeds, `/map` route compiles
  (with toggle + inspector).
- **BFF proxy live smoke**: unauthenticated tile request → `401` (server-side
  gate; token never exposed); `/map` route reachable (`200`); web boots clean.
- **Backend unaffected**: P2.9 is web-only (no API change) — API suite stays
  254/254 (32 suites).

## Addendum (2026-06-05) — shipped a real basemap (theme-aware CARTO)

**Problem.** The original "sovereign-safe default" basemap was an empty
`minimalStyle` — a single `background` layer with a solid color and **no tiles**.
With `NEXT_PUBLIC_MAP_STYLE_URL` unset (the normal case), `/map` rendered as a
flat colored slab with no geographic reference, which users reasonably read as
"the map doesn't display." A blank-by-default map is the wrong default for an
operations console.

**Decision.** Give `/map` a real basemap out of the box while preserving the
air-gap escape hatch:

- **Default:** theme-aware **CARTO raster** tiles — `light_all` on the light
  theme, `dark_all` on the dark theme (ADR-0077). The basemap re-tints live when
  the theme toggles, by swapping **only** the raster source/layer (GIS layers and
  their per-layer visibility are left untouched, and the basemap is re-inserted
  **below** the first GIS layer so features stay on top). Compact attribution
  (`© OpenStreetMap © CARTO`) is shown, satisfying the providers' terms.
- **Override priority (unchanged escape hatch, now documented + widened):**
  1. `NEXT_PUBLIC_MAP_STYLE_URL` — a full self-hosted MapLibre **vector style**
     JSON (best for production / fully offline). Used verbatim; we don't manage
     its theming.
  2. `NEXT_PUBLIC_MAP_RASTER_URL` — a single **raster XYZ** template used for both
     themes (e.g. `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, or a
     self-hosted raster).
  3. Neither set → the CARTO default above.

**Trade-off / sovereignty note.** The default now makes the **browser** call a
third-party tile host (CARTO/OSM) and therefore needs internet. This was an
explicit product choice (operator opted for "online OSM/CARTO") to make the map
usable immediately. A **fully offline** deployment must set one of the two env
vars above and self-host tiles (a bundled offline tile server in the infra
compose remains a follow-on — see the GIS gaps in the tracker).

**Validation.** web `tsc` + `lint` + `next build` clean (`/map` compiles); CARTO
`light_all`/`dark_all` tile reachability checked (HTTP 200, `image/png`); authed
`/map` → `200` with `MapView` + layer panel server-rendered, no SSR error;
no CSP blocks external tiles. In-browser WebGL draw remains a human check.

---

## Addendum (2026-06-06): user-selectable basemaps + proxied tiles

The single theme-aware CARTO basemap is now a **basemap picker** with several
options, and **all** basemap tiles are fetched through the same-origin proxy
`app/api/map/tiles/[variant]` (the browser never calls the tile CDNs directly —
works behind restrictive/government networks where only the server has outbound
internet).

- **Options:** Авто (theme-aware CARTO light/dark), Voyager (CARTO), Светлая,
  Тёмная, OpenStreetMap, Спутник (Esri World Imagery), Топографическая (Esri
  World Topo). The choice is **persisted in `localStorage`** (`cmc.basemap`) and
  applied live by swapping only the raster source/layer (GIS layers untouched,
  basemap re-inserted below them). `Авто` still follows the light/dark theme.
- **Proxy registry (SSRF-safe):** `variant` must be a key in a fixed registry
  (CARTO paths incl. Voyager's `rastertiles/voyager`; OSM; Esri imagery/topo with
  `{z}/{y}/{x}` order) and `z/x/y` are numeric — so it can only fetch a known
  public basemap, never an arbitrary URL. A `User-Agent` is sent (OSM policy).
- **Override priority** is unchanged: `NEXT_PUBLIC_MAP_STYLE_URL` (vector) >
  `NEXT_PUBLIC_MAP_RASTER_URL` (raster) > the picker. When an env override is
  set the picker is hidden (the basemap is pinned).

**Validation.** `tsc`/`lint`/`next build` clean (`/map` 6.13 kB). Proxy probes
(Tajikistan tile z6/x44/y24): light_all/dark_all/voyager → 200 `image/png`,
satellite/topo → 200 `image/jpeg`, osm → 200 `image/png`, bad key → 400. Live
browser: picker shows 7 localized options; selecting **Спутник** persisted
`cmc.basemap=satellite`, fired 24 `/api/map/tiles/satellite` requests, and the
map rendered Esri imagery of Tajikistan (screenshot) — GIS layers stayed on top.
