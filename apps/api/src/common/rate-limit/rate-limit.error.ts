/**
 * Thrown by `RateLimitService.enforce(...)` when at least one of the
 * presented limits has been exceeded. The HTTP exception filter
 * (`HttpExceptionFilter`) translates this into a 429 response with a
 * `Retry-After` header + problem+json body.
 *
 * Not a NestJS `HttpException` subclass on purpose — we want a single
 * place (the filter) that owns the transport mapping. Subclassing
 * `HttpException` would entangle that decision with the throw site.
 */
export class RateLimitExceededError extends Error {
  constructor(
    /** Stable name of the breached limit (e.g. "auth-login-ip"). */
    public readonly limitName: string,
    /** Seconds until the breached counter expires; safe to send as
     *  `Retry-After`. Always ≥ 1 — guarantees the client retries no
     *  sooner than the breached window allows. */
    public readonly retryAfterSec: number,
    /** The count observed when the breach was detected — for audit. */
    public readonly observedCount: number,
    /** Configured limit at breach time — for audit. */
    public readonly configuredLimit: number,
  ) {
    super(`Rate limit exceeded: ${limitName}`);
    this.name = "RateLimitExceededError";
  }
}
