import { auth } from "@/auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * BFF collaboration-ticket mint (P4.1b / ADR-0060). The browser must NOT hold
 * the access JWT (BFF posture), so to open the Hocuspocus WS it POSTs here; the
 * NextAuth session cookie rides along, this handler attaches the API bearer
 * **server-side** and forwards to `POST /v1/collab/ticket`. The minted ticket
 * (single-use, short-lived) is the only credential that reaches the browser.
 * The upstream status (403/404/…) is passed through so the editor can fall back.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.accessToken) {
    return new Response(null, { status: 401 });
  }

  let pageId: unknown;
  try {
    pageId = (await req.json())?.pageId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof pageId !== "string") {
    return new Response(null, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE_URL}/v1/collab/ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pageId }),
      cache: "no-store",
    });
  } catch {
    return new Response(null, { status: 502 });
  }

  const body = await upstream.text();
  return new Response(upstream.ok ? body : null, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
