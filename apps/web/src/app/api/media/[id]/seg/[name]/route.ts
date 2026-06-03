import { auth } from "@/auth";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * BFF HLS segment proxy (P4.5b / ADR-0063). Streams one `.ts` segment from the
 * API (RBAC-checked there) with the bearer attached server-side.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
): Promise<Response> {
  const { id, name } = await params;
  const session = await auth();
  if (!session?.accessToken) return new Response(null, { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_BASE_URL}/v1/media/assets/${encodeURIComponent(id)}/seg/${encodeURIComponent(name)}`,
      {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        cache: "no-store",
      },
    );
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "video/mp2t",
      "Cache-Control": "private, max-age=60",
    },
  });
}
