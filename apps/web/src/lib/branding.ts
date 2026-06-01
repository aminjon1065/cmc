import "server-only";
import { cache } from "react";
import { DEFAULT_BRANDING, type TenantBranding } from "@cmc/contracts";
import { apiFetch } from "./api";
import { authedApiFetch } from "./server-api";

/**
 * Branding fetch helpers (P0.11 / ADR-0018).
 *
 * `GET /branding` is context-aware on the API:
 *   - anonymous (login page, root metadata) → the default tenant's branding
 *   - authenticated (dashboard, sidebar)     → the caller's tenant branding
 *
 * Both helpers fall back to the generic DEFAULT_BRANDING if the API is
 * unreachable, so a branding-service blip never takes a page down. `cache()`
 * dedupes the call within a single server render.
 */

/** Anonymous branding — for pre-auth pages (login, root layout metadata). */
export const getPublicBranding = cache(async (): Promise<TenantBranding> => {
  try {
    return await apiFetch<TenantBranding>("/branding");
  } catch {
    return DEFAULT_BRANDING;
  }
});

/** Authenticated branding — for the signed-in shell (sidebar, dashboard). */
export const getBranding = cache(async (): Promise<TenantBranding> => {
  try {
    return await authedApiFetch<TenantBranding>("/branding");
  } catch {
    return DEFAULT_BRANDING;
  }
});
