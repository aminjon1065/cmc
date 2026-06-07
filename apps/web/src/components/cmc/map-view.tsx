"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type {
  FilterSpecification,
  Map as MlMap,
  MapGeoJSONFeature,
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import type { GisLayerResponse } from "@cmc/contracts";

/** The MVT layer name produced by the API's `ST_AsMVT(t, 'features', …)`. */
const SOURCE_LAYER = "features";

/**
 * GIS overlay source (ADR-0079, Phase 3):
 *
 *   NEXT_PUBLIC_GIS_SOURCE = "geoserver" (default) | "mvt"
 *
 * - **geoserver** — each GIS layer is a server-rendered **WMS raster** from
 *   GeoServer (via the same-origin BFF proxy `/api/gis/wms`), styled with the
 *   `cmc_default` SLD. The web then looks IDENTICAL to QGIS / ArcGIS Pro (one
 *   source, one style). Clicks use WMS **GetFeatureInfo** so the inspector keeps
 *   working. The web GIS overlay depends on GeoServer being up (the basemap does
 *   not — a GeoServer outage degrades to "basemap only", never a blank map).
 * - **mvt** — the original client-rendered vector tiles from the API
 *   (`/api/gis/tiles`): per-layer palette colours + client-side inspect. Use
 *   this if GeoServer isn't deployed.
 */
const GIS_SOURCE = (process.env.NEXT_PUBLIC_GIS_SOURCE ?? "geoserver") as
  | "geoserver"
  | "mvt";
const GS_WORKSPACE = process.env.NEXT_PUBLIC_GEOSERVER_WORKSPACE ?? "cmc";
const USE_GEOSERVER = GIS_SOURCE === "geoserver";

/**
 * Basemap configuration (P2.9 / ADR-0039; basemap picker added 2026-06-06).
 *
 *   NEXT_PUBLIC_MAP_STYLE_URL  — a full MapLibre vector style JSON URL
 *                                (self-hosted / MapTiler). Highest priority;
 *                                when set we use it verbatim, don't manage the
 *                                raster basemap, and hide the picker.
 *   NEXT_PUBLIC_MAP_RASTER_URL — a single raster XYZ template used for BOTH
 *                                themes; also pins the basemap (picker hidden).
 *
 * With neither set, the user picks a basemap from several options (persisted in
 * localStorage). All tiles are fetched through our same-origin proxy
 * (`/api/map/tiles/<basemap>/z/x/y`), so they work behind restrictive networks
 * where only the server has outbound internet.
 */
const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
const RASTER_URL = process.env.NEXT_PUBLIC_MAP_RASTER_URL;

const MAP_BG_DARK = "#0b0f14";
const MAP_BG_LIGHT = "#e6ebf2";
/** CMC accent — matches the GeoServer `cmc_default` SLD fill/stroke. */
const ACCENT = "#2f6fe0";

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} © <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>`;
const ESRI_ATTRIBUTION =
  'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> — Esri, Maxar, Earthstar Geographics';

/** Selectable basemaps. `auto` follows the light/dark theme (CARTO); the rest
 *  pin a specific basemap. Ids (except `auto`) MUST match the proxy registry in
 *  `app/api/map/tiles/[variant]/route.ts`. */
type BasemapId =
  | "auto"
  | "voyager"
  | "light_all"
  | "dark_all"
  | "osm"
  | "satellite"
  | "topo";

const BASEMAP_OPTIONS: { id: BasemapId; labelKey: string }[] = [
  { id: "auto", labelKey: "bm.auto" },
  { id: "voyager", labelKey: "bm.voyager" },
  { id: "light_all", labelKey: "bm.light" },
  { id: "dark_all", labelKey: "bm.dark" },
  { id: "osm", labelKey: "bm.osm" },
  { id: "satellite", labelKey: "bm.satellite" },
  { id: "topo", labelKey: "bm.topo" },
];
const BASEMAP_IDS = new Set(BASEMAP_OPTIONS.map((o) => o.id));
const BASEMAP_LS_KEY = "cmc.basemap";

function loadBasemap(): BasemapId {
  if (typeof window === "undefined") return "auto";
  const v = window.localStorage.getItem(BASEMAP_LS_KEY);
  return v && BASEMAP_IDS.has(v as BasemapId) ? (v as BasemapId) : "auto";
}

function proxyTiles(variant: string): string[] {
  // Same-origin proxy (app/api/map/tiles) → the browser never hits the tile CDNs
  // directly (works behind restrictive networks / blockers).
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return [`${origin}/api/map/tiles/${variant}/{z}/{x}/{y}`];
}

function attributionFor(id: BasemapId): string {
  if (id === "osm") return OSM_ATTRIBUTION;
  if (id === "satellite" || id === "topo") return ESRI_ATTRIBUTION;
  return CARTO_ATTRIBUTION;
}

function isDarkNow(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

/** The raster basemap source for the chosen basemap + theme. A custom env raster
 *  (NEXT_PUBLIC_MAP_RASTER_URL) overrides everything. `auto` maps to the CARTO
 *  light/dark variant for the current theme. */
function basemapSourceFor(id: BasemapId, dark: boolean): RasterSourceSpecification {
  if (RASTER_URL) {
    return {
      type: "raster",
      tileSize: 256,
      tiles: [RASTER_URL],
      attribution: OSM_ATTRIBUTION,
    };
  }
  const variant = id === "auto" ? (dark ? "dark_all" : "light_all") : id;
  return {
    type: "raster",
    tileSize: 256,
    tiles: proxyTiles(variant),
    attribution: attributionFor(id),
  };
}

/** A self-contained style: a theme backdrop (shown while tiles load) plus the
 *  raster basemap. GIS layers are added on top after `load`. */
function basemapStyle(dark: boolean, id: BasemapId): StyleSpecification {
  return {
    version: 8,
    sources: { basemap: basemapSourceFor(id, dark) },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": dark ? MAP_BG_DARK : MAP_BG_LIGHT },
      },
      { id: "basemap", type: "raster", source: "basemap" },
    ],
  };
}

const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#06b6d4",
];

const SUFFIXES = ["fill", "line", "circle"] as const;

// ── GeoServer (WMS) helpers ────────────────────────────────────────────────

/** GeoServer layer name for a GIS layer — MUST match the slug `setup.sh`
 *  produces (`infra/geoserver/setup.sh`: lower-case, non-alnum → `_`, trimmed).
 *  Falls back to `layer_<uuid-head>` exactly like the script does. */
function gsLayerName(layer: { id: string; name: string }): string {
  const slug = layer.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${GS_WORKSPACE}:${slug || `layer_${layer.id.split("-")[0]}`}`;
}

/** Web-Mercator (EPSG:3857) forward projection for GetFeatureInfo bbox. */
function toMerc(lng: number, lat: number): [number, number] {
  const R = 6378137;
  const x = (R * lng * Math.PI) / 180;
  const clamped = Math.max(Math.min(lat, 85.06), -85.06);
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  return [x, y];
}

/** WMS GetMap tile template for MapLibre (it substitutes `{bbox-epsg-3857}`). */
function wmsTiles(layerName: string): string[] {
  const origin = window.location.origin;
  const qs = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetMap",
    layers: layerName,
    styles: "",
    format: "image/png",
    transparent: "true",
    width: "256",
    height: "256",
    srs: "EPSG:3857",
  });
  // Keep the {bbox-epsg-3857} token literal (URLSearchParams would encode it).
  return [`${origin}/api/gis/wms?${qs.toString()}&bbox={bbox-epsg-3857}`];
}

/** Add each GIS layer as a server-rendered WMS raster from GeoServer. */
function addGeoServerLayers(map: MlMap, layers: GisLayerResponse[]): void {
  layers.forEach((layer) => {
    const src = `gis-${layer.id}`;
    if (map.getSource(src)) return;
    map.addSource(src, {
      type: "raster",
      tiles: wmsTiles(gsLayerName(layer)),
      tileSize: 256,
    });
    map.addLayer({
      id: `${src}-wms`,
      type: "raster",
      source: src,
      paint: { "raster-opacity": 0.92 },
    });
  });
}

// ── MVT (vector) helpers ───────────────────────────────────────────────────

/** Add each GIS layer (vector source via the BFF tile proxy → fill+line+circle)
 *  on top of the basemap. Idempotent: skips a layer whose source already
 *  exists, so it is safe to call again after a basemap swap. */
function addGisLayers(map: MlMap, layers: GisLayerResponse[]): void {
  layers.forEach((layer, i) => {
    const color = PALETTE[i % PALETTE.length]!;
    const src = `gis-${layer.id}`;
    if (map.getSource(src)) return;
    map.addSource(src, {
      type: "vector",
      tiles: [
        `${window.location.origin}/api/gis/tiles/${layer.id}/{z}/{x}/{y}`,
      ],
      minzoom: 0,
      maxzoom: 22,
    });
    map.addLayer({
      id: `${src}-fill`,
      type: "fill",
      source: src,
      "source-layer": SOURCE_LAYER,
      filter: ["==", ["geometry-type"], "Polygon"] as FilterSpecification,
      paint: {
        "fill-color": color,
        "fill-opacity": 0.25,
        "fill-outline-color": color,
      },
    });
    map.addLayer({
      id: `${src}-line`,
      type: "line",
      source: src,
      "source-layer": SOURCE_LAYER,
      filter: ["==", ["geometry-type"], "LineString"] as FilterSpecification,
      paint: { "line-color": color, "line-width": 1.5 },
    });
    map.addLayer({
      id: `${src}-circle`,
      type: "circle",
      source: src,
      "source-layer": SOURCE_LAYER,
      filter: ["==", ["geometry-type"], "Point"] as FilterSpecification,
      paint: {
        "circle-radius": 5,
        "circle-color": color,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#ffffff",
      },
    });
  });
}

/** Render-layer ids for one GIS layer (used for toggling + MVT querying). */
function renderIdsFor(layerId: string): string[] {
  return USE_GEOSERVER
    ? [`gis-${layerId}-wms`]
    : SUFFIXES.map((s) => `gis-${layerId}-${s}`);
}

type Selected = {
  layerName: string;
  geometryType: string;
  properties: Record<string, unknown>;
};

/**
 * MapLibre GL map of the tenant's GIS layers (P2.9 / ADR-0039; GeoServer WMS
 * source ADR-0079). MapLibre is dynamic-imported inside the effect so it never
 * loads on the server. A user-selectable raster basemap sits underneath (CARTO
 * light/dark/voyager, OSM, Esri satellite/topo — all via the same-origin proxy);
 * each GIS layer is added on top — as a GeoServer WMS raster (default,
 * server-styled identically to QGIS/ArcGIS) or as API MVT vectors (fallback). A
 * toggle panel controls per-layer visibility; clicking a feature opens a
 * property inspector (WMS GetFeatureInfo, or client query for MVT).
 */
export function MapView({ layers }: { layers: GisLayerResponse[] }) {
  const t = useTranslations("map");
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(layers.map((l) => [l.id, true])),
  );
  const [selected, setSelected] = useState<Selected | null>(null);
  // Init to "auto" (matches SSR) then load the persisted choice after mount to
  // avoid a hydration mismatch on the <select>.
  const [basemapId, setBasemapId] = useState<BasemapId>("auto");

  // Mirror latest state into refs so the (once-registered) map handlers read
  // current values without re-binding.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const basemapIdRef = useRef(basemapId);
  basemapIdRef.current = basemapId;

  /** Swap the raster basemap in place, keeping the GIS layers on top. No-op for
   *  a user-supplied vector style (it manages its own basemap). Stable across
   *  renders (only changes when `layers` changes) so the map-init effect below
   *  isn't re-run on every render. */
  const swapBasemap = useCallback(
    (id: BasemapId): void => {
      const m = mapRef.current;
      if (!m || STYLE_URL) return;
      const dark = isDarkNow();
      const before = layers[0]
        ? `gis-${layers[0].id}-${USE_GEOSERVER ? "wms" : "fill"}`
        : undefined;
      try {
        if (m.getLayer("basemap")) m.removeLayer("basemap");
        if (m.getSource("basemap")) m.removeSource("basemap");
        m.addSource("basemap", basemapSourceFor(id, dark));
        m.addLayer(
          { id: "basemap", type: "raster", source: "basemap" },
          before && m.getLayer(before) ? before : undefined,
        );
      } catch {
        // Ignore transient "style not done loading" races.
      }
    },
    [layers],
  );

  // Load the persisted basemap after mount (client-only).
  useEffect(() => {
    const v = loadBasemap();
    if (v !== "auto") setBasemapId(v);
  }, []);

  // Apply basemap changes live once the map exists.
  useEffect(() => {
    if (mapRef.current) swapBasemap(basemapId);
  }, [basemapId, swapBasemap]);

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | undefined;
    let themeObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const nameOf = new Map(layers.map((l) => [l.id, l.name]));
    const mvtRenderIds = layers.flatMap((l) =>
      SUFFIXES.map((s) => `gis-${l.id}-${s}`),
    );

    // WMS GetFeatureInfo: query all currently-visible GeoServer layers at the
    // clicked pixel and show the top hit in the inspector.
    async function inspectWms(m: MlMap, point: { x: number; y: number }) {
      const slugs = layers
        .filter((l) => visibleRef.current[l.id] ?? true)
        .map((l) => gsLayerName(l));
      if (slugs.length === 0) {
        setSelected(null);
        return;
      }
      const canvas = m.getCanvas();
      const b = m.getBounds();
      const [minx, miny] = toMerc(b.getWest(), b.getSouth());
      const [maxx, maxy] = toMerc(b.getEast(), b.getNorth());
      const qs = new URLSearchParams({
        service: "WMS",
        version: "1.1.1",
        request: "GetFeatureInfo",
        layers: slugs.join(","),
        query_layers: slugs.join(","),
        styles: "",
        srs: "EPSG:3857",
        bbox: `${minx},${miny},${maxx},${maxy}`,
        width: String(canvas.clientWidth),
        height: String(canvas.clientHeight),
        x: String(Math.round(point.x)),
        y: String(Math.round(point.y)),
        info_format: "application/json",
        feature_count: "5",
      });
      try {
        const res = await fetch(`/api/gis/wms?${qs.toString()}`);
        if (!res.ok) {
          setSelected(null);
          return;
        }
        const fc = (await res.json()) as {
          features?: Array<{
            id?: string;
            geometry?: { type?: string };
            properties?: Record<string, unknown>;
          }>;
        };
        const f = fc.features?.[0];
        if (!f) {
          setSelected(null);
          return;
        }
        // GeoServer feature ids look like "<layername>.<fid>" → recover the layer.
        const slug = typeof f.id === "string" ? f.id.split(".")[0] : "";
        const layer = layers.find(
          (l) => gsLayerName(l).split(":")[1] === slug,
        );
        setSelected({
          layerName: layer?.name ?? slug ?? "",
          geometryType: f.geometry?.type ?? "unknown",
          properties: (f.properties ?? {}) as Record<string, unknown>,
        });
      } catch {
        setSelected(null);
      }
    }

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL || basemapStyle(isDarkNow(), basemapIdRef.current),
        center: [71, 38.8], // Tajikistan
        zoom: 6,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({}), "top-right");

      // The container's final size settles AFTER this async init (dynamic
      // import + flex/`calc` layout). If we don't tell MapLibre, it can keep a
      // 0/stale viewport and never request basemap tiles → a blank map. Observe
      // the container and resize on any size change.
      resizeObserver = new ResizeObserver(() => mapRef.current?.resize());
      resizeObserver.observe(containerRef.current);

      // Re-tint the backdrop on theme toggle; for `auto` basemap also swap the
      // CARTO light/dark tiles (ADR-0077). A pinned basemap stays as chosen.
      themeObserver = new MutationObserver(() => {
        const m = mapRef.current;
        if (!m) return;
        const dark = isDarkNow();
        if (m.getLayer("background")) {
          m.setPaintProperty(
            "background",
            "background-color",
            dark ? MAP_BG_DARK : MAP_BG_LIGHT,
          );
        }
        if (STYLE_URL || RASTER_URL) return;
        if (basemapIdRef.current === "auto") swapBasemap("auto");
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });

      map.on("load", () => {
        if (!map) return;
        map.resize(); // ensure correct size before first tile request
        if (USE_GEOSERVER) addGeoServerLayers(map, layers);
        else addGisLayers(map, layers);
        // Ensure the persisted/selected basemap is applied under the GIS layers
        // (covers the map-load-vs-localStorage race).
        swapBasemap(basemapIdRef.current);
      });

      // Click → inspect the top feature; empty click clears the panel.
      map.on("click", (e) => {
        if (!map) return;
        if (USE_GEOSERVER) {
          void inspectWms(map, e.point);
          return;
        }
        const feats = map.queryRenderedFeatures(e.point, {
          layers: mvtRenderIds,
        });
        const f = feats[0] as MapGeoJSONFeature | undefined;
        if (!f) {
          setSelected(null);
          return;
        }
        const layerId =
          typeof f.source === "string" ? f.source.replace(/^gis-/, "") : "";
        setSelected({
          layerName: nameOf.get(layerId) ?? layerId,
          geometryType: f.geometry?.type ?? "unknown",
          properties: (f.properties ?? {}) as Record<string, unknown>,
        });
      });

      // Pointer cursor: MVT can query locally; for GeoServer use a crosshair to
      // signal the map is clickable (GetFeatureInfo runs on click).
      if (USE_GEOSERVER) {
        map.on("mouseenter", () => {
          if (map) map.getCanvas().style.cursor = "crosshair";
        });
      } else {
        map.on("mousemove", (e) => {
          if (!map) return;
          const hit = map.queryRenderedFeatures(e.point, {
            layers: mvtRenderIds,
          });
          map.getCanvas().style.cursor = hit.length ? "pointer" : "";
        });
      }
    })();

    return () => {
      cancelled = true;
      themeObserver?.disconnect();
      resizeObserver?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, [layers, swapBasemap]);

  function toggleLayer(layerId: string, on: boolean): void {
    setVisible((v) => ({ ...v, [layerId]: on }));
    const map = mapRef.current;
    if (!map) return;
    for (const id of renderIdsFor(layerId)) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    }
  }

  function onPickBasemap(id: BasemapId): void {
    setBasemapId(id);
    try {
      window.localStorage.setItem(BASEMAP_LS_KEY, id);
    } catch {
      // ignore storage failures (private mode etc.)
    }
  }

  // Legend swatch: GeoServer renders every layer in the single accent colour
  // (the cmc_default SLD); MVT colours each layer from the palette.
  const swatchColor = (i: number): string =>
    USE_GEOSERVER ? ACCENT : (PALETTE[i % PALETTE.length] as string);

  const showPicker = !STYLE_URL && !RASTER_URL;

  return (
    <div className="relative h-[calc(100vh-104px)] min-h-[480px] w-full">
      {/* h-full (not `absolute inset-0`): maplibre-gl.css forces
          `.maplibregl-map { position: relative }`, which cancels `inset-0` and
          collapses the container to height 0 → blank map. height:100% of the
          definite-height parent is position-agnostic and always fills. */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Layer toggle panel */}
      {layers.length > 0 ? (
        <div
          className="cmc-card absolute left-3 top-3 z-10 w-56 p-2"
          style={{ background: "var(--c-bg-2)" }}
        >
          <div className="cmc-label mb-1.5 px-1">{t("layers")}</div>
          <div className="flex flex-col gap-1">
            {layers.map((l, i) => (
              <label
                key={l.id}
                className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-[11.5px]"
              >
                <input
                  type="checkbox"
                  checked={visible[l.id] ?? true}
                  onChange={(e) => toggleLayer(l.id, e.target.checked)}
                />
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ background: swatchColor(i) }}
                />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="cmc-mono" style={{ color: "var(--c-fg-3)" }}>
                  {l.featureCount}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="absolute left-3 top-3 z-10 rounded-md px-3 py-2 text-[11.5px]"
          style={{ background: "var(--c-bg-2)", color: "var(--c-fg-3)" }}
        >
          {t("noLayers")}
        </div>
      )}

      {/* Basemap picker */}
      {showPicker && (
        <div
          className="cmc-card absolute bottom-3 left-3 z-10 flex items-center gap-2 px-2 py-1.5"
          style={{ background: "var(--c-bg-2)" }}
        >
          <span className="cmc-label">{t("basemap")}</span>
          <select
            aria-label={t("basemap")}
            value={basemapId}
            onChange={(e) => onPickBasemap(e.target.value as BasemapId)}
            className="rounded-md px-1.5 py-0.5 text-[11.5px]"
            style={{
              background: "var(--c-bg-1)",
              color: "var(--c-fg-1)",
              border: "1px solid var(--c-border)",
            }}
          >
            {BASEMAP_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Feature inspector */}
      {selected && (
        <div
          className="cmc-card absolute right-3 top-3 z-10 w-64"
          style={{ background: "var(--c-bg-2)" }}
        >
          <div className="cmc-card-header flex items-center">
            <span className="cmc-label">{selected.layerName}</span>
            <div className="flex-1" />
            <button
              type="button"
              aria-label={t("close")}
              onClick={() => setSelected(null)}
              style={{ color: "var(--c-fg-3)" }}
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
          <div className="flex flex-col gap-1 p-3 text-[11px]">
            <div className="flex justify-between gap-2">
              <span style={{ color: "var(--c-fg-3)" }}>{t("geometry")}</span>
              <span className="cmc-mono">{selected.geometryType}</span>
            </div>
            {Object.entries(selected.properties).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span style={{ color: "var(--c-fg-3)" }}>{k}</span>
                <span className="cmc-mono truncate" style={{ maxWidth: "60%" }}>
                  {String(v)}
                </span>
              </div>
            ))}
            {Object.keys(selected.properties).length === 0 && (
              <div style={{ color: "var(--c-fg-4)" }}>{t("noProperties")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
