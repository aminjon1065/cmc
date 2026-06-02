"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { X } from "lucide-react";
import type {
  FilterSpecification,
  Map as MlMap,
  MapGeoJSONFeature,
  StyleSpecification,
} from "maplibre-gl";
import type { GisLayerResponse } from "@cmc/contracts";

/** The MVT layer name produced by the API's `ST_AsMVT(t, 'features', …)`. */
const SOURCE_LAYER = "features";

/**
 * Basemap: set `NEXT_PUBLIC_MAP_STYLE_URL` to a real style (self-hosted, or
 * `https://demotiles.maplibre.org/style.json` for dev). Default is a minimal,
 * fully self-contained style (no external calls) — GIS layers render on top.
 */
const STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL;
const MINIMAL_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0b0f14" },
    },
  ],
};

const PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#06b6d4",
];

const SUFFIXES = ["fill", "line", "circle"] as const;

type Selected = {
  layerName: string;
  geometryType: string;
  properties: Record<string, unknown>;
};

/**
 * MapLibre GL map of the tenant's GIS layers (P2.9 / ADR-0039). MapLibre is
 * dynamic-imported inside the effect so it never loads on the server. Each layer
 * → a vector source pointing at the BFF tile proxy (`/api/gis/tiles/...`),
 * rendered as fill + line + circle. A toggle panel controls per-layer
 * visibility; clicking a feature opens a property inspector.
 */
export function MapView({ layers }: { layers: GisLayerResponse[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(layers.map((l) => [l.id, true])),
  );
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | undefined;
    const nameOf = new Map(layers.map((l) => [l.id, l.name]));
    const renderLayerIds = layers.flatMap((l) =>
      SUFFIXES.map((s) => `gis-${l.id}-${s}`),
    );

    void (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL || MINIMAL_STYLE,
        center: [71, 38.8], // Tajikistan
        zoom: 6,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({}), "top-right");

      map.on("load", () => {
        if (!map) return;
        layers.forEach((layer, i) => {
          const color = PALETTE[i % PALETTE.length]!;
          const src = `gis-${layer.id}`;
          map!.addSource(src, {
            type: "vector",
            tiles: [
              `${window.location.origin}/api/gis/tiles/${layer.id}/{z}/{x}/{y}`,
            ],
            minzoom: 0,
            maxzoom: 22,
          });
          map!.addLayer({
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
          map!.addLayer({
            id: `${src}-line`,
            type: "line",
            source: src,
            "source-layer": SOURCE_LAYER,
            filter: [
              "==",
              ["geometry-type"],
              "LineString",
            ] as FilterSpecification,
            paint: { "line-color": color, "line-width": 1.5 },
          });
          map!.addLayer({
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
      });

      // Click → inspect the top feature; empty click clears the panel.
      map.on("click", (e) => {
        if (!map) return;
        const feats = map.queryRenderedFeatures(e.point, {
          layers: renderLayerIds,
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

      map.on("mousemove", (e) => {
        if (!map) return;
        const hit = map.queryRenderedFeatures(e.point, {
          layers: renderLayerIds,
        });
        map.getCanvas().style.cursor = hit.length ? "pointer" : "";
      });
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [layers]);

  function toggleLayer(layerId: string, on: boolean): void {
    setVisible((v) => ({ ...v, [layerId]: on }));
    const map = mapRef.current;
    if (!map) return;
    for (const s of SUFFIXES) {
      const id = `gis-${layerId}-${s}`;
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
    }
  }

  return (
    <div className="relative h-[calc(100vh-104px)] min-h-[480px] w-full">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Layer toggle panel */}
      {layers.length > 0 ? (
        <div
          className="cmc-card absolute left-3 top-3 z-10 w-56 p-2"
          style={{ background: "var(--c-bg-2)" }}
        >
          <div className="cmc-label mb-1.5 px-1">Layers</div>
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
                  style={{ background: PALETTE[i % PALETTE.length] }}
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
          No GIS layers yet — create one via the API (`POST /v1/gis/layers`).
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
              aria-label="Close"
              onClick={() => setSelected(null)}
              style={{ color: "var(--c-fg-3)" }}
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
          <div className="flex flex-col gap-1 p-3 text-[11px]">
            <div className="flex justify-between gap-2">
              <span style={{ color: "var(--c-fg-3)" }}>geometry</span>
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
              <div style={{ color: "var(--c-fg-4)" }}>No properties</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
