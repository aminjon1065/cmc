/**
 * Same-origin basemap raster-tile proxy.
 *
 * The browser fetches map tiles from THIS origin (`/api/map/tiles/<basemap>/z/x/y`);
 * the server fetches the upstream tile and streams it back. This decouples the
 * map from the browser's ability to reach the tile CDNs directly — it works
 * behind restrictive/government networks, ad/tracker blockers, or when only the
 * server has outbound internet (the browser only needs to reach the app). Tiles
 * are public basemap data, so no auth is required; responses are cached hard.
 *
 * SSRF-safe: `variant` must be a key in the BASEMAPS registry below and z/x/y are
 * numeric-validated, so this can only ever fetch one of a fixed set of public
 * basemap tiles — never an arbitrary URL.
 */
const SUBDOMAINS = ["a", "b", "c", "d"];

/** CARTO raster basemaps → their CDN path. Most are served at `/<name>/…`, but
 *  Voyager lives under `/rastertiles/voyager/…`. (a–d subdomains, spread
 *  deterministically.) */
const CARTO_PATHS: Record<string, string> = {
  light_all: "light_all",
  dark_all: "dark_all",
  voyager: "rastertiles/voyager",
  // Aliases kept for back-compat: positron == light, dark_matter == dark.
  positron: "light_all",
  dark_matter: "dark_all",
};

/** Non-CARTO basemaps → upstream URL builder. Note Esri uses {z}/{y}/{x} order
 *  and has no file extension. */
const OTHER_BASEMAPS: Record<
  string,
  (z: string, x: string, y: string) => string
> = {
  osm: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  // Esri World Imagery (satellite) + World Topo — public ArcGIS Online services.
  satellite: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  topo: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`,
};

function upstreamUrl(variant: string, z: string, x: string, y: string): string | null {
  const cartoPath = CARTO_PATHS[variant];
  if (cartoPath) {
    const sd = SUBDOMAINS[(Number(x) + Number(y)) % SUBDOMAINS.length];
    return `https://${sd}.basemaps.cartocdn.com/${cartoPath}/${z}/${x}/${y}.png`;
  }
  const build = OTHER_BASEMAPS[variant];
  return build ? build(z, x, y) : null;
}

export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ variant: string; z: string; x: string; y: string }>;
  },
): Promise<Response> {
  const { variant, z, x, y } = await params;

  if (
    !/^\d{1,2}$/.test(z) ||
    !/^\d{1,7}$/.test(x) ||
    !/^\d{1,7}$/.test(y)
  ) {
    return new Response(null, { status: 400 });
  }
  const url = upstreamUrl(variant, z, x, y);
  if (!url) return new Response(null, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
        // OSM's tile policy requires a valid User-Agent; send one for all.
        "User-Agent": "CMC-Platform/1.0 (self-hosted GIS map)",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/png",
      // Basemap tiles are effectively immutable — let the browser cache hard.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
