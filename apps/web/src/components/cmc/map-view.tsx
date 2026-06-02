"use client";

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  FilterSpecification,
  Map as MlMap,
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

/**
 * MapLibre GL map of the tenant's GIS layers (P2.9 / ADR-0039). MapLibre is
 * dynamic-imported inside the effect so it never loads on the server. Each layer
 * becomes a vector source pointing at the BFF tile proxy (`/api/gis/tiles/...`),
 * rendered as fill + line + circle so any geometry type shows.
 */
export function MapView({ layers }: { layers: GisLayerResponse[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | undefined;

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
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [layers]);

  return (
    <div className="relative h-[calc(100vh-104px)] min-h-[480px] w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {layers.length === 0 && (
        <div
          className="absolute left-3 top-3 z-10 rounded-md px-3 py-2 text-[11.5px]"
          style={{ background: "var(--c-bg-2)", color: "var(--c-fg-3)" }}
        >
          No GIS layers yet — create one via the API (`POST /v1/gis/layers`).
        </div>
      )}
    </div>
  );
}
