/**
 * Thin API client for the NestJS backend (apps/api).
 * Centralised so future cross-cutting concerns (auth, retry, tracing headers)
 * live in one place.
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

  // IMPORTANT: spreading a `Headers` object via `{...init.headers}` silently
  // drops every header (Headers stores entries internally, not as own enumerable
  // properties). Build the final Headers via the `Headers` constructor and
  // .set so callers can pass any HeadersInit shape — plain object, array of
  // tuples, or Headers — without losing what they set.
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    ...init,
    headers,
    cache: init.cache ?? "no-store",
  });

  if (!res.ok) {
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // ignore parse errors; body stays undefined
    }
    throw new ApiError(res.status, `API ${res.status} on ${path}`, body);
  }

  // 204 No Content (and friends — empty Content-Length) carry no body;
  // calling res.json() throws "Unexpected end of JSON input".
  if (
    res.status === 204 ||
    res.status === 205 ||
    res.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
