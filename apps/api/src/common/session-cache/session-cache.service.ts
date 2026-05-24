import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../modules/redis/redis.tokens";

/**
 * Payload cached per active session. Only what's needed to:
 *   1. Confirm the JWT's `sub` / `tid` claims match the session row
 *      that was looked up (defence-in-depth — JWT signing already
 *      binds these, but a hypothetical confused-deputy bug elsewhere
 *      would be caught here).
 *   2. Anything else the hot path needs without going to DB. Today
 *      that's nothing else; expand cautiously.
 *
 * Specifically NOT cached: email, roles (when they land), session
 * metadata. Each addition is a multiplier on cache memory + a new
 * invalidation surface — only add when the hot path actually benefits.
 */
export type SessionCachePayload = {
  userId: string;
  tenantId: string;
};

/**
 * Redis-backed cache for "is this session active?". See ADR-0011.
 *
 * Cache key shape: `cmc:auth:session-active:<sid>`
 * TTL: configured by the caller (typically equal to the access-token
 * lifetime so a failed DEL adds zero exposure beyond the JWT's natural
 * expiry).
 *
 * Failure mode: **fail-open to DB.** If Redis errors mid-call we log
 * at warn level and return `null` from `get()` so the middleware
 * falls through to the existing DB query. The DB is the source of
 * truth; we are only ever optimising it away.
 *
 * Invalidation: every revoke / rotate path in `SessionsService`
 * must call `del(sid)` (single) or `delMany(sids)` (family) AFTER
 * the corresponding UPDATE commits. The DEL is best-effort —
 * failure is bounded by the TTL safety net.
 */
@Injectable()
export class SessionCacheService {
  private readonly logger = new Logger(SessionCacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Look up a cached session-active payload by sid.
   *
   *   - Returns the payload when the key is present and decodes
   *     cleanly. The caller is expected to verify the payload's
   *     userId / tenantId match the JWT claims before trusting it.
   *   - Returns `null` on cache miss, malformed payload, or any
   *     Redis error. The caller falls through to DB.
   */
  async get(sid: string): Promise<SessionCachePayload | null> {
    try {
      const raw = await this.redis.get(this.key(sid));
      if (raw == null) return null;
      const parsed = JSON.parse(raw) as Partial<SessionCachePayload>;
      if (
        typeof parsed.userId !== "string" ||
        typeof parsed.tenantId !== "string"
      ) {
        // Corrupt entry — clean it up so subsequent requests don't
        // keep replaying the decode failure.
        await this.redis.del(this.key(sid)).catch(() => undefined);
        return null;
      }
      return { userId: parsed.userId, tenantId: parsed.tenantId };
    } catch (err) {
      this.logger.warn(
        `Session-cache GET failed for sid=${sid} (failing open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Populate the cache after a successful DB-confirmed active lookup.
   *
   * `ttlSec` is the cache lifetime. ADR-0011 recommends setting it to
   * the access-token lifetime so a missed `del()` adds zero exposure
   * beyond the access token's natural expiry.
   *
   * SET failures are non-fatal (the next request will just take the
   * DB hit again).
   */
  async set(
    sid: string,
    payload: SessionCachePayload,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.redis.set(this.key(sid), JSON.stringify(payload), "EX", ttlSec);
    } catch (err) {
      this.logger.warn(
        `Session-cache SET failed for sid=${sid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Invalidate a single session. Called after `SessionsService.revoke()`,
   * `SessionsService.rotate()` (for the predecessor sid), and the
   * single-session admin-revoke path.
   *
   * Idempotent: DEL on an absent key is a no-op.
   */
  async del(sid: string): Promise<void> {
    try {
      await this.redis.del(this.key(sid));
    } catch (err) {
      this.logger.warn(
        `Session-cache DEL failed for sid=${sid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Invalidate multiple sessions in one shot. Called by
   * `SessionsService.revokeFamily()` and the refresh-replay family
   * burn.
   *
   * Splits into batches of 1000 to stay well below the
   * `proto-max-bulk-len` Redis default and to keep any single failure
   * from poisoning the whole batch.
   */
  async delMany(sids: string[]): Promise<void> {
    if (sids.length === 0) return;
    const BATCH = 1000;
    for (let i = 0; i < sids.length; i += BATCH) {
      const slice = sids.slice(i, i + BATCH).map((s) => this.key(s));
      try {
        await this.redis.del(...slice);
      } catch (err) {
        this.logger.warn(
          `Session-cache DEL batch failed (${slice.length} keys): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private key(sid: string): string {
    return `cmc:auth:session-active:${sid}`;
  }
}
