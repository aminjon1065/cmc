/**
 * Conventions for Redis key naming.
 *
 * Pure documentation today — no runtime logic. Promoted to enforcement
 * (typed builder + lint rule) when an explicitly tenant-scoped consumer
 * arrives (P2 cache for tenant settings or P2.5 ClickHouse-projection
 * cache). Until then, the convention below is the contract every Redis
 * consumer MUST follow.
 *
 * Existing consumers (none are tenant-scoped; all key on sid / IP /
 * email-hash):
 *   - P0.1 / ADR-0009 — auth rate-limit
 *   - P0.4 / ADR-0011 — session-active cache
 *
 * ---
 *
 * Namespace shape: `cmc:<domain>:<...>`
 *
 *   cmc:auth:rate-limit:login:ip:<ip>          (P0.1 / ADR-0009)
 *   cmc:auth:rate-limit:login:email:<sha256>   (P0.1 / ADR-0009)
 *   cmc:auth:rate-limit:refresh:ip:<ip>        (P0.1 / ADR-0009)
 *   cmc:auth:session-active:<sid>              (P0.4 / ADR-0011)
 *   cmc:tenant:<tenant_id>:dashboard:<dashboard_id>:cache
 *   cmc:bullmq:<queue-name>:<job-id>
 *   cmc:ws:presence:<resource_id>
 *
 * Rules:
 *   1. Prefix every key with `cmc:` so the same Redis instance can host
 *      siblings (other services, test runs) without collision.
 *   2. Tenant-scoped data MUST embed `tenant:<tenant_id>:` so a `KEYS`
 *      sweep can audit-list a tenant's entire cache footprint at a glance.
 *   3. Test keys use `cmc:test:` and are short-lived (EX). Tests share one
 *      Redis instance with dev; do not FLUSHDB.
 *   4. Hot keys (high read rate) carry an `EX` TTL even when the data is
 *      "permanent" — Redis is a cache, not a database.
 */
export const REDIS_KEY_PREFIX = "cmc";
