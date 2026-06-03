import { auth } from "@/auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * BFF HLS playlist proxy (P4.5b / ADR-0063). hls.js fetches this same-origin so
 * the session cookie rides along; this handler attaches the API bearer
 * **server-side** and returns the rewritten `.m3u8` (segment URIs already point
 * at `seg/<name>`, which resolve to the segment proxy beside this route). The
 * access token never reaches the player.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await auth();
  if (!session?.accessToken) return new Response(null, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_BASE_URL}/v1/media/assets/${encodeURIComponent(id)}/playlist.m3u8`,
      {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        cache: "no-store",
      },
    );
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
    },
  });
}
