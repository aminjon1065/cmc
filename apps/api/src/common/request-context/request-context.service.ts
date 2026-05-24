import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request transport-level identity. Distinct from `TenantContext`
 * (security-level identity) because:
 *
 *   - `request_id` exists for *every* request, including anonymous ones
 *     and ones that fail JWT verification. The durable audit path on
 *     login failure / rate-limit denial needs it.
 *   - `request_id` is what correlates log lines, audit rows, traces,
 *     and (future) outbound calls — not who the caller is.
 *
 * `correlationId` is reserved for the future case where the platform
 * receives an inbound `X-Correlation-Id` from an integration partner
 * and must thread that identifier through to downstream audit + logs
 * without conflating it with our own per-hop `request_id`.
 */
export type RequestContext = {
  /** UUID v4. Always set. */
  requestId: string;
  /** Optional upstream correlation id (e.g. cross-system trace). */
  correlationId?: string;
};

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  getCurrent(): RequestContext | undefined {
    return this.storage.getStore();
  }

  /** Convenience: just the request_id, or `undefined` if outside scope. */
  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }
}
