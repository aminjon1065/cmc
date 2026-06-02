import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context shared by every service involved in handling a request.
 * Populated by `TenantContextMiddleware` from the validated JWT.
 */
export type TenantContext = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  email: string;
  /** Session id (`sid` claim on the access JWT). */
  sessionId: string;
  /**
   * How the request was authenticated (P3.9 / ADR-0054). Absent/"user" = JWT
   * session; "apikey" = an API key, whose permissions are `apiKeyScopes`.
   */
  principalType?: "user" | "apikey";
  /** The authenticating API key's id (api-key principals only). */
  apiKeyId?: string;
  /** The API key's granted permission strings (api-key principals only). */
  apiKeyScopes?: string[];
};

/**
 * Wraps Node's AsyncLocalStorage so any service can read the active
 * tenant/user without threading parameters through every call site.
 *
 * Usage from a domain service:
 *   const tenantId = this.tenantContext.requireCurrent().tenantId;
 *
 * Background jobs / cron / event consumers that have no request context
 * MUST manually `tenantContext.run({...}, () => doWork())` to set one,
 * otherwise `requireCurrent()` will throw.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  run<T>(context: TenantContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  getCurrent(): TenantContext | undefined {
    return this.storage.getStore();
  }

  requireCurrent(): TenantContext {
    const ctx = this.getCurrent();
    if (!ctx) {
      throw new Error(
        "No tenant context active. This code path requires an authenticated request or an explicit tenantContext.run(...) wrapper.",
      );
    }
    return ctx;
  }
}
