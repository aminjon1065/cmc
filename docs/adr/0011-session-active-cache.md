# ADR-0011: Redis cache for session-active lookup

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.4
**Closes tech-debt:** TD-018
**Depends on:** ADR-0008 (Redis tier-1)

## Context

Since ADR-0003 (server-side sessions), every authenticated request
runs the same DB lookup in `TenantContextMiddleware`:

```ts
SELECT id FROM sessions
 WHERE id = :sid
   AND user_id = :sub
   AND tenant_id = :tid
   AND revoked_at IS NULL
   AND expires_at > now()
 LIMIT 1
```

This is the dominant query on the read path. At Horizon-1 scale
(~1000 active users × ~1 req/s) it's ~1000 indexed Postgres SELECTs
per second purely for session validation. The query itself is fast
(< 1 ms) but it scales linearly with request volume and pre-empts a
DB connection on every request.

[TD-018 in the audit](../audit/TECH_DEBT_REGISTER.md) flagged this as
the first cache opportunity to harvest once Redis (ADR-0008) is wired.

## Decision

### 1. Cache contract

| Aspect | Value |
|---|---|
| Key | `cmc:auth:session-active:<sid>` |
| Value | JSON `{ userId, tenantId }` |
| TTL | `SESSION_CACHE_TTL_SEC` (default **900s** — matches `JWT_ACCESS_TTL` default) |
| Set on | First successful DB-confirmed active lookup |
| Cleared on | every `revoke()`, `revokeFamily()`, `rotate()` (predecessor) and `rotate()` family-burn path, plus `revokeExpired()` |
| Failure mode | **Fail-open to DB** on any Redis error |

### 2. TTL = access-token lifetime (load-bearing decision)

The cache stores "this sid was active at lookup time." A revoked sid
whose `DEL` fails (Redis hiccup, network drop) would otherwise persist
"active" up to TTL.

Setting TTL **equal to the access-token lifetime** gives an elegant
property: even if the cache `DEL` never runs, the access token expires
no later than TTL — so the cache adds **zero marginal exposure**
beyond the JWT's natural expiry.

- Lower TTL (60 s, 30 s): tighter post-failure recovery but lower
  cache hit rate.
- Higher TTL: silently extends stolen-token grace past the access
  token's natural expiry, which is a security regression.

The default `SESSION_CACHE_TTL_SEC=900` (15 min) tracks the default
`JWT_ACCESS_TTL=15m`. Operators who shorten `JWT_ACCESS_TTL` should
match `SESSION_CACHE_TTL_SEC` to preserve the property.

### 3. Cache value includes `{ userId, tenantId }`

The JWT signature already binds `sub` / `tid` to the issued session,
so caching just a marker would be correct under normal operation.
However:

- Verifying the cached `userId` / `tenantId` against the JWT claims
  is **free defence-in-depth** — a hypothetical confused-deputy bug
  elsewhere in the platform (e.g. a refactor that mis-issues a JWT)
  would be caught here rather than silently accepted.
- On payload mismatch, the middleware **falls through to the DB**.
  This is verified by `session-cache.e2e-spec.ts:"a poisoned cache
  entry with wrong userId is ignored"`.

The payload is also tiny — two UUIDs in JSON — so the memory cost is
negligible.

### 4. Failure mode: fail-open to DB

If the Redis `GET` errors (connection drop, timeout), the service
warn-logs and returns `null` — the middleware then runs the existing
DB query unchanged. The DB is the source of truth; we are only ever
optimising it away.

This differs from rate-limit's fail-open (which **allows the request
unmetered** — a real trade-off). Session-cache fail-open is **lossless
for correctness** because the DB query still runs.

### 5. Invalidation is centralised in `SessionsService`

Every code path that transitions a session out of "active":

| Method | Invalidation |
|---|---|
| `revoke(id, reason)` | `sessionCache.del(id)` |
| `revokeFamily(familyId, reason)` | UPDATE with `RETURNING id` → `sessionCache.delMany(ids)` |
| `rotate()` — successful path | `sessionCache.del(predecessor.id)` |
| `rotate()` — replay-family-burn | UPDATE with `RETURNING id` → `sessionCache.delMany(ids)` |
| `revokeExpired()` | already had `RETURNING id` → `sessionCache.delMany(ids)` |

`revokeFamily` and the replay-burn previously ran bulk UPDATEs without
returning ids. They now use `.returning({ id })` so the cache DEL is
precise rather than relying on a broader pattern wipe.

### 6. The successor session is NOT pre-warmed on rotation

Rotation invalidates the predecessor's cache entry. The successor is
**not** pre-populated — it lazily populates on its first authenticated
request. Pre-warming would write cache entries for sessions that may
never be used (token issued and immediately discarded). The first
real use absorbs one extra Redis SET, which is sub-millisecond.

### 7. Module placement: `common/session-cache/`

`SessionCacheService` lives in `common/` so both the middleware
(`common/tenant-context/`) and `SessionsService` (`modules/auth/`)
can inject it cleanly:

- `common/session-cache` → depends only on Redis (`modules/redis/`)
- `common/tenant-context` → `common/session-cache` ✓
- `modules/auth/sessions.service` → `common/session-cache` ✓

The dependency graph is monotonic. `SessionsService` (a domain service)
can depend on a `common/` service; `common/` services never reach into
domain modules.

### 8. Test isolation

`truncateAll(sql, redis)` previously wiped only `cmc:auth:rate-limit:*`
keys (P0.1). It now wipes the broader `cmc:auth:*` pattern — covering
both the rate-limit counters AND the session-cache entries. Tests that
exercise the `/auth/*` surface must pass the redis client.

The session-cache TTL is configured to 60 s in `.env.test.example`
(vs 900 s in production) — short enough that lingering test state
expires before the next CI run, while still giving real-cache
behaviour during the suite.

## Consequences

**Positive:**

- DB load on the read path drops orders of magnitude. At steady state,
  one DB SELECT per session per TTL window (worst case) instead of per
  request — i.e., from ~1000 RPS DB load (1000 users × 1 req/s) down
  to ~1 RPS in the same scenario.
- `runPrivileged()` pool slots free up — fewer "no tenant scope yet"
  transactions on the hot path.
- The cache invalidation surface is centralised in one service so
  future revoke paths only need one DEL call to maintain correctness.
- TD-018 retired.

**Negative / known gaps:**

- **No cache hit/miss metrics yet.** P0.7 (Prometheus) lands the
  observability for cache effectiveness. Until then, hit rate is
  inferred from the absence of DB load.
- **Cache failures are silent.** Warn-logged but not paged. P1.8
  Alertmanager rules will surface chronic cache-error patterns.
- **Single Redis instance** today (ADR-0008) — when Redis is down the
  cache never serves; DB load returns to baseline. Acceptable per the
  fail-open posture; HA Redis lands at P3.13.
- **Cache value is small but not encrypted.** Both fields are UUIDs;
  not PII; the session-existence fact is already revealed by the
  cache key itself. Documented; no action.

## Triggers for re-evaluation

- Steady-state cache hit rate drops below ~95 % once metrics land →
  investigate TTL, invalidation cascade, or session churn pattern.
- Two distinct revoke-without-RETURNING paths slip into the codebase
  → the cache invariant is silently broken; lint rule or code-review
  checklist required.
- The Redis hot-key footprint grows large enough to OOM (millions of
  sessions) → consider H3 sharded Redis or moving session existence
  to a bloom filter.
- HA Redis lands → `del` becomes async-on-replica; consider explicit
  `WAIT` for revoke paths where strict consistency matters.

## References

- [PRIORITY_EXECUTION_PLAN P0.4](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-018](../audit/TECH_DEBT_REGISTER.md)
- [SCALABILITY_REVIEW §12 item 1](../audit/SCALABILITY_REVIEW.md)
- [ADR-0003](./0003-sessions-refresh-rls.md) — the session model this caches
- [ADR-0008](./0008-redis-tier-1-dependency.md)
