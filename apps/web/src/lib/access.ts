import "server-only";
import { cache } from "react";
import {
  MyAccessResponseSchema,
  type MyAccessResponse,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "./server-api";

export type Access = MyAccessResponse;

/**
 * The current user's effective access (roles + permissions), from the API's
 * `GET /rbac/me` (P1.4a / ADR-0022).
 *
 * Memoised per request via React `cache()` so the `/admin` layout, the page,
 * and the sidebar share ONE round-trip. Returns null when there's no session
 * or the call fails — callers treat null as "no access" (fail closed).
 *
 * Permissions are resolved server-side (not carried in the auth token), so
 * this is always fresh relative to a role change, modulo the API's own Redis
 * permission cache.
 */
export const getMyAccess = cache(async (): Promise<Access | null> => {
  try {
    const raw = await authedApiFetch<unknown>("/rbac/me");
    const parsed = MyAccessResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    // 401 (no/expired session) and any transport error both mean "no access".
    if (err instanceof ApiError) return null;
    return null;
  }
});

/** Whether the access set includes a given permission string. */
export function hasPermission(
  access: Access | null,
  permission: string,
): boolean {
  return access?.permissions.includes(permission) ?? false;
}

/**
 * Whether the user may enter the admin section at all. Gated on `user:manage`
 * — the core admin capability, held only by `tenant_admin` today. Individual
 * admin pages additionally gate on their own permission (e.g. `role:read`).
 */
export function isAdmin(access: Access | null): boolean {
  return hasPermission(access, "user:manage");
}
