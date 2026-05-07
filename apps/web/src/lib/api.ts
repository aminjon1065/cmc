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
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
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

  return res.json() as Promise<T>;
}
