import { auth } from "@/auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * BFF vector-tile proxy (P2.9 / ADR-0039). MapLibre fetches tiles same-origin,
 * so the NextAuth session cookie rides along; this handler reads the session,
 * attaches the API bearer **server-side**, and streams the MVT back. The access
 * token therefore never reaches the browser — same posture as `authedApiFetch`.
 */
export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ layerId: string; z: string; x: string; y: string }>;
  },
): Promise<Response> {
  const { layerId, z, x, y } = await params;
  const session = await auth();
  if (!session?.accessToken) {
    return new Response(null, { status: 401 });
  }

  const seg = (s: string) => encodeURIComponent(s);
  const url = `${API_BASE_URL}/v1/gis/tiles/${seg(layerId)}/${seg(z)}/${seg(x)}/${seg(y)}.mvt`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: "no-store",
    });
  } catch {
    return new Response(null, { status: 502 });
  }

  if (upstream.status === 204) return new Response(null, { status: 204 });
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      "Cache-Control": "private, max-age=60",
    },
  });
}
