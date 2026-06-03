import { auth } from "@/auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * BFF video-join-token mint (P4.2b / ADR-0061). The browser must NOT hold the
 * access JWT, so to join a LiveKit room it POSTs here; this handler attaches the
 * API bearer **server-side** and forwards to `POST /v1/video/rooms/:id/token`.
 * Only the short-lived, room-scoped LiveKit token reaches the browser. Upstream
 * status (403 no-perm / 404 / 409 closed) is passed through so the UI can react.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.accessToken) {
    return new Response(null, { status: 401 });
  }

  let roomId: unknown;
  try {
    roomId = (await req.json())?.roomId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof roomId !== "string") {
    return new Response(null, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_BASE_URL}/v1/video/rooms/${encodeURIComponent(roomId)}/token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        cache: "no-store",
      },
    );
  } catch {
    return new Response(null, { status: 502 });
  }

  const body = await upstream.text();
  return new Response(upstream.ok ? body : null, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
