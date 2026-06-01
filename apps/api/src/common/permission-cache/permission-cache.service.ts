import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Permission } from "@cmc/contracts";
import { REDIS } from "../../modules/redis/redis.tokens";

/**
 * Redis-backed cache of a user's resolved permission set (P1.1 / ADR-0019).
 *
 * Key:  `cmc:authz:perms:<tenantId>:<userId>`  (tenant-scoped per the
 *        redis-keys convention).
 * Value: JSON array of permission strings.
 * TTL:   `RBAC_PERM_CACHE_TTL_SEC` (default 300s) — a bounded staleness
 *        window even if an invalidation DEL is missed.
 *
 * Failure mode: **fail-open to DB**, exactly like the session cache
 * (ADR-0011). Any Redis error → `get` returns null and the caller resolves
 * from Postgres. The DB is the source of truth; the cache only optimises it.
 *
 * Invalidation: every path that changes a user's effective permissions —
 * assign/remove a role, change a role's permissions — must call `del(...)`
 * (one user) or `delTenant(...)` (all users in a tenant, for a role-level
 * change). Best-effort; bounded by the TTL.
 */
@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(tenantId: string, userId: string): string {
    return `cmc:authz:perms:${tenantId}:${userId}`;
  }

  /** Cached permission set for a user, or null on miss / error. */
  async get(
    tenantId: string,
    userId: string,
  ): Promise<Set<Permission> | null> {
    try {
      const raw = await this.redis.get(this.key(tenantId, userId));
      if (raw == null) return null;
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return null;
      return new Set(arr as Permission[]);
    } catch (err) {
      this.logger.warn(
        `permission cache GET failed (fail-open to DB): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Cache a user's resolved permission set with the TTL. */
  async set(
    tenantId: string,
    userId: string,
    perms: Set<Permission>,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.key(tenantId, userId),
        JSON.stringify([...perms]),
        "EX",
        ttlSec,
      );
    } catch (err) {
      this.logger.warn(
        `permission cache SET failed (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Invalidate one user's cached permissions (role assigned/removed). */
  async del(tenantId: string, userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(tenantId, userId));
    } catch (err) {
      this.logger.warn(
        `permission cache DEL failed (bounded by TTL): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Invalidate every cached permission set in a tenant — used when a role's
   * permissions change (which can affect many users). SCAN (not KEYS) so a
   * large keyspace doesn't block Redis.
   */
  async delTenant(tenantId: string): Promise<void> {
    const pattern = `cmc:authz:perms:${tenantId}:*`;
    try {
      let cursor = "0";
      do {
        const [next, batch] = await this.redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          200,
        );
        cursor = next;
        if (batch.length > 0) await this.redis.del(...batch);
      } while (cursor !== "0");
    } catch (err) {
      this.logger.warn(
        `permission cache delTenant failed (bounded by TTL): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
