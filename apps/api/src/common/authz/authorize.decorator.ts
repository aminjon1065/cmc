import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@cmc/contracts";

/** Reflector key under which required permissions are stored. */
export const AUTHORIZE_KEY = "cmc:authorize:permissions";

/**
 * Require one or more permissions to invoke a handler (P1.1 / ADR-0019).
 *
 *   @Authorize('document:read')
 *   @Authorize('document:write', 'document:delete')   // ALL required
 *
 * Enforced by `AuthorizeGuard`. A handler with no `@Authorize` is not
 * permission-gated (auth is still handled by `JwtAuthGuard` where applied).
 */
export const Authorize = (...permissions: Permission[]) =>
  SetMetadata(AUTHORIZE_KEY, permissions);
