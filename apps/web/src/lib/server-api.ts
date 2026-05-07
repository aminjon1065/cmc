import "server-only";
import { auth } from "@/auth";
import { ApiError, apiFetch } from "./api";

/**
 * Server-only API caller that automatically attaches the current session's
 * access token. Use from server components, server actions, and Route Handlers.
 *
 * If there is no session, the call goes through unauthenticated — the API
 * itself will reject protected endpoints with 401.
 */
export async function authedApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const session = await auth();
  const headers = new Headers(init.headers ?? {});
  if (session?.accessToken) {
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }
  return apiFetch<T>(path, { ...init, headers });
}

export { ApiError };
