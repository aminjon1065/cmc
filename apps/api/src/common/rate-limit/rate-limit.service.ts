import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../modules/redis/redis.tokens";
import { AuditService } from "../../modules/audit/audit.service";
import { RateLimitExceededError } from "./rate-limit.error";

/**
 * Declarative spec for one Redis-backed rate-limit window.
 *
 * `key` returning `null` opts this spec out for the given attempt (used
 * for refresh, which has no email — see `auth-rate-limit.specs.ts`).
 *
 * `keyDescriptor` is the *category* the breach gets audited under
 * (e.g. "ip" / "email") — distinct from the full Redis key so audit
 * metadata stays semantic rather than leaking the hashed form.
 *
 * `audit` (optional) tells the service how to record the denial. The
 * throttled request never reaches its real handler, so without this
 * record the brute-force attempt would be invisible to the audit log.
 * Set `audit: undefined` for non-auth consumers (e.g. anti-DoS throttles
 * where every reach is loud at the proxy already).
 */
export type RateLimitSpec = {
  /** Stable identifier — appears in audit metadata + thrown error. */
  name: string;
  /** Max requests in `windowSec`. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Full Redis key for the counter. `null` skips this spec for this call. */
  redisKey: string | null;
  /** Short category label for the breach, e.g. "ip" or "email". */
  keyDescriptor: string;
  /** Audit shape on breach. Omit to skip audit. */
  audit?: {
    action: string;
    resourceType: string;
    actorId?: string | null;
    tenantId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    /** Extra metadata merged into the audit row's `metadata` jsonb. */
    metadata?: Record<string, unknown>;
  };
};

/**
 * Fixed-window-counter rate limiter.
 *
 * Algorithm: `INCR key`; on first hit set `EXPIRE key window NX`. The NX
 * guard ensures the window doesn't keep getting extended on every hit
 * (which would make the counter never reset). Both ops run inside a
 * `MULTI` so the count returned is the post-increment count *and* the
 * TTL is established atomically.
 *
 * Failure mode: if Redis errors mid-check, we **fail open** (allow the
 * request) and warn-log. Reasoning:
 *   - Redis being unreachable mid-request is a transient infra issue;
 *     locking out 100 % of auth traffic to "be safe" is a self-DoS.
 *   - The whole API would have failed to boot if Redis were down at
 *     start (ADR-0008 fail-fast PING).
 *   - The audit log still captures the failed-credential side of any
 *     attack, so brute-force is not invisible.
 * Documented in ADR-0009.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  /**
   * Apply each spec in order. On first breach, throw — subsequent specs
   * are NOT consumed (we don't want a denied request to still inflate
   * other counters).
   */
  async enforce(specs: RateLimitSpec[]): Promise<void> {
    for (const spec of specs) {
      if (spec.redisKey == null) continue;

      let observed: number;
      try {
        observed = await this.consume(spec.redisKey, spec.windowSec);
      } catch (err) {
        this.logger.warn(
          `Rate-limit check failed for ${spec.name} (failing open): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      if (observed > spec.limit) {
        const retryAfter = await this.safeTtl(spec.redisKey);
        if (spec.audit) {
          // Write a durable denial audit BEFORE throwing. The request
          // will end as a 429 (no surrounding tx to piggyback on for
          // anonymous auth endpoints), so we need the audit to commit
          // in its own privileged transaction.
          await this.audit.record({
            tenantId: spec.audit.tenantId ?? null,
            actorId: spec.audit.actorId ?? null,
            actorType: spec.audit.actorId ? "user" : "anonymous",
            action: spec.audit.action,
            resourceType: spec.audit.resourceType,
            outcome: "denied",
            ip: spec.audit.ip ?? null,
            userAgent: spec.audit.userAgent ?? null,
            metadata: {
              reason: "rate_limit_exceeded",
              limit_name: spec.name,
              limit_key: spec.keyDescriptor,
              limit: spec.limit,
              observed: observed,
              window_sec: spec.windowSec,
              retry_after_sec: retryAfter,
              ...(spec.audit.metadata ?? {}),
            },
            durable: true,
          });
        }
        throw new RateLimitExceededError(
          spec.name,
          retryAfter,
          observed,
          spec.limit,
        );
      }
    }
  }

  /**
   * Internal: atomic INCR + (set TTL if new). Returns the post-increment
   * value. `EXPIRE key sec NX` only sets the TTL when none is present,
   * so a window started by the first hit is not extended by subsequent
   * ones — which is the difference between "fixed window" and
   * "rolling-on-every-hit". The latter is a well-known bug; we guard
   * against it explicitly.
   */
  private async consume(key: string, windowSec: number): Promise<number> {
    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, windowSec, "NX");
    const replies = await pipeline.exec();
    if (!replies || replies.length < 1) {
      throw new Error("MULTI returned no replies");
    }
    const [incrErr, incrVal] = replies[0]!;
    if (incrErr) throw incrErr;
    if (typeof incrVal !== "number") {
      throw new Error(`INCR returned ${typeof incrVal}, expected number`);
    }
    return incrVal;
  }

  /**
   * Compute the seconds-remaining for the breached key. Errors here are
   * non-fatal — fall back to the window length we know was configured
   * (passed as a fallback would be cleaner but the breach site doesn't
   * have the spec handy, so we ask Redis and default to 1 if TTL is
   * unset or negative).
   */
  private async safeTtl(key: string): Promise<number> {
    try {
      const ttl = await this.redis.ttl(key);
      // ttl = -2 (no key) or -1 (no TTL) → conservative 1s; otherwise honour Redis.
      return ttl > 0 ? ttl : 1;
    } catch {
      return 1;
    }
  }
}
