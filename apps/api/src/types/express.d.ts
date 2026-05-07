import type { TenantContext } from "../common/tenant-context/tenant-context.service";

/**
 * Augment Express's Request type so middleware can stash typed per-request
 * data without resorting to `any`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

export {};
