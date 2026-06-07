import { auth } from "@/auth";

/**
 * Same-origin BFF proxy to **GeoServer WMS** (ADR-0079, Phase 3).
 *
 * The browser's MapLibre map fetches GIS overlays from THIS origin
 * (`/api/gis/wms?...`); the server forwards each request to GeoServer and
 * streams the result back. This means:
 *   - the browser never needs to reach GeoServer directly (works behind
 *     restrictive networks; only the app server needs to reach `:8088`);
 *   - GeoServer's host/port stay server-side (in prod GeoServer is NOT exposed
 *     publicly — only via this proxy + Caddy);
 *   - the web renders the SAME server-side, SLD-styled layers QGIS/ArcGIS see.
 *
 * Auth: requires a NextAuth session (same posture as the MVT proxy) so GIS data
 * isn't served to anonymous same-origin callers.
 *
 * SSRF-safe: the upstream host + path are FIXED (`$GEOSERVER_URL/$WS/wms`); only
 * an allow-list of WMS params is forwarded, and `request` must be a known WMS
 * operation — so this can only ever talk to the configured GeoServer WMS.
 */
const GEOSERVER_URL = (
  process.env.GEOSERVER_URL ?? "http://localhost:8088/geoserver"
).replace(/\/+$/, "");
const WORKSPACE = process.env.GEOSERVER_WORKSPACE ?? "cmc";

const ALLOWED_REQUESTS = new Set([
  "GetMap",
  "GetFeatureInfo",
  "GetCapabilities",
  "GetLegendGraphic",
]);

// Only these WMS params are forwarded (lower-cased keys). Fixed host+path +
// curated params = no arbitrary-URL fetch.
const ALLOWED_PARAMS = new Set([
  "service",
  "version",
  "request",
  "layers",
  "query_layers",
  "styles",
  "style",
  "format",
  "info_format",
  "transparent",
  "width",
  "height",
  "srs",
  "crs",
  "bbox",
  "x",
  "y",
  "i",
  "j",
  "feature_count",
  "cql_filter",
  "exceptions",
  "bgcolor",
  "tiled",
  "layer",
  "scale",
  "legend_options",
]);

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session) return new Response(null, { status: 401 });

  const inUrl = new URL(req.url);
  const request =
    inUrl.searchParams.get("request") ??
    inUrl.searchParams.get("REQUEST") ??
    "";
  if (!ALLOWED_REQUESTS.has(request)) {
    return new Response(null, { status: 400 });
  }

  const upstream = new URL(`${GEOSERVER_URL}/${WORKSPACE}/wms`);
  for (const [k, v] of inUrl.searchParams) {
    if (ALLOWED_PARAMS.has(k.toLowerCase())) upstream.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(upstream.toString(), { cache: "no-store" });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!res.ok) return new Response(null, { status: res.status });

  const body = await res.arrayBuffer();
  const contentType =
    res.headers.get("content-type") ?? "application/octet-stream";
  // Rendered map tiles are briefly cacheable; feature-info / capabilities aren't.
  const cacheControl =
    request === "GetMap" || request === "GetLegendGraphic"
      ? "private, max-age=60"
      : "no-store";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
  });
}
