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
