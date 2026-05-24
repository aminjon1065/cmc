# ADR-0008: Redis as a tier-1 infrastructure dependency

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.2
**Closes tech-debt:** TD-013

## Context

ADR-0001 enumerated Redis as one of the three Day-1 infrastructure services
(`Postgres`, `Redis`, `MinIO`). The container has been running locally and in
CI's compose definition since the first commit, but **no application code
touched it**. TD-013 captured this in the audit:

> Redis present but unused → cache opportunities being left on the table
> (session-active lookup is one).

P0.1 (rate limiting), P0.4 (session cache), P2.3 (WebSocket fanout), P2.13
(BullMQ preview workers), P3.13 (Redis Sentinel) all depend on a Redis
client being wired into the API. P0.2 unblocks that band.

This ADR captures the **architectural commitment** that adoption implies:
once the API requires Redis at boot, Redis is operationally co-equal with
Postgres for "the API needs this to start." It is no longer optional
infrastructure.

## Decision

### 1. Client library: `ioredis@^5.4.1`

Chosen for:

- **Pipelining** — required for atomic rate-limit windows once P0.1 lands.
- **Lua eval** — required for safe atomic check-and-set rate-limit
  primitives.
- **Pub/Sub + Streams** — required for P2.3 WebSocket cross-instance
  fanout.
- **Sentinel / Cluster** — required for H3 HA; URL/options reshape, no
  refactor.
- **BullMQ-native** — P2.13 preview workers reuse the same client (or its
  config) instead of bringing a second Redis library.

Rejected: `node-redis` (good library, but BullMQ-incompatible without
adapters); `@nestjs/cache-manager` (useful as a layered cache wrapper
later, not as the primary client).

### 2. Single-client model, mirrors `DatabaseModule`

- Symbol token `REDIS` in `redis.tokens.ts` (mirrors `DB` in
  `database.tokens.ts`).
- A `@Global()` `RedisModule` constructs the client via `useFactory` from
  the validated `REDIS_URL`.
- A `RedisLifecycle` provider implements `OnModuleInit` (PING on boot,
  fail-fast on misconfiguration) and `OnModuleDestroy` (graceful `QUIT`
  with a `disconnect()` fallback for double-shutdown cases).
- ioredis lifecycle events (`connect`, `ready`, `reconnecting`, `end`,
  `error`) route to a NestJS `Logger`.
- **No tenant-scoping helper service yet.** Mirrors the DB pattern only up
  through "client + lifecycle"; the equivalent of `TenantDatabaseService`
  for Redis is a key-naming convention, not a service. Promoted to an
  enforcement helper when the second consumer arrives — see point 5.

### 3. Boot-time PING fails the app on misconfiguration

`OnModuleInit` issues a `PING` and throws on anything but `PONG`. This
choice is deliberate: every future consumer (rate-limit, session cache,
WS) will silently break if the client cannot reach Redis. Failing the
boot makes misconfiguration loud, immediate, and unambiguous.

The ioredis factory pins `maxRetriesPerRequest: 3` so boot fails within
seconds rather than hanging through default 20 retries.

### 4. Observability today is via the Logger only

Per the controlled-mode rules ("Do NOT touch future roadmap items"):

- Prometheus metrics for Redis ops land with **P0.7**.
- Deep health probe (`/health/ready` pinging Redis) lands with **P0.8**.

Today the operational signal is structured(-ish) log lines on connect /
ready / reconnect / error, plus the `cmc-api` connection name visible in
`CLIENT LIST`.

### 5. Key-naming convention documented, not enforced

`apps/api/src/modules/redis/redis-keys.ts` documents the canonical key
shape:

```
cmc:<domain>:<...>
cmc:auth:rate-limit:login:<ip>:<email-hash>
cmc:auth:session:<sid>
cmc:tenant:<tenant_id>:<domain>:<resource>:<...>
cmc:bullmq:<queue>:<job_id>
cmc:ws:presence:<resource_id>
cmc:test:<arbitrary>
```

Rules:

1. Every key prefixed with `cmc:` (avoids collision with other tenants of
   the same Redis instance in shared deployments).
2. Tenant-scoped data **must** embed `tenant:<tenant_id>:` so a `KEYS`
   sweep can audit a tenant's footprint at a glance.
3. Test keys use `cmc:test:` and carry short EX TTLs; tests must not
   `FLUSHDB`.
4. Hot keys carry an `EX` TTL even when the data is "permanent" — Redis
   is a cache, not a database.

Today this lives as a documentation file with no runtime helper. It is
**the contract** every consumer must follow. The first explicitly
tenant-scoped consumer (after the per-IP P0.1 rate-limit and per-`sid`
P0.4 session cache) promotes this file to a typed key builder and lint
rule.

### 6. CI starts a real Redis container

`.github/workflows/ci.yml` now starts a `redis:7-alpine` container with
the same password (`cmc_dev_redis_change_me`) as `infra/.env.example`.
The seed step and Playwright env block already had `REDIS_URL` lines;
they are now updated to include the password so the API can actually
authenticate.

The teardown step is extended to remove `cmc-redis-ci` so cancelled runs
don't leak containers.

### 7. Test isolation strategy

E2E tests share one Redis instance with the dev process. Test keys use
the `cmc:test:` prefix and short EX TTLs. **Tests do not `FLUSHDB`** —
that would destroy dev state during interleaved runs. A dedicated Redis
logical-DB-index per environment is the path forward if shared-instance
collisions become a real problem; today the prefix discipline suffices.

## Consequences

**Positive:**

- Unblocks P0.1, P0.4, P2.3, P2.13.
- TD-013 retired — Redis is no longer paying infrastructure-rent without
  application benefit.
- Boot-time fail-fast removes a class of "intermittent runtime error"
  bugs that would otherwise emerge as P0.1 etc. land.
- The single-client model preserves the option to swap to Sentinel or
  Cluster in production without refactoring application code.

**Negative / known gaps:**

- **API now fails to start without Redis.** Local dev requires
  `pnpm infra:up` before `pnpm dev`. CI must keep the Redis container
  running for the duration of the integration job.
- **No Prometheus metrics for Redis ops.** Cache hit / miss / latency
  histograms wait for P0.7.
- **No deep health probe for Redis.** `GET /health` is still
  liveness-only (touched in P0.8).
- **No TLS in transit to Redis.** Plaintext on the docker network in
  dev/CI; production deployments behind a TLS terminator or VPC-private
  network must specify `rediss://` in the URL. Captured in
  [TECH_DEBT_REGISTER.md](../audit/TECH_DEBT_REGISTER.md) as a new item.
- **No tenant-scoping enforcement.** Key naming is a convention. The
  first consumer that violates it will leak across tenants. Mitigated by
  RBAC absence (every authenticated user in a tenant already sees all
  data) but must be addressed as RBAC arrives.

## Triggers for re-evaluation

- A second NestJS process appears (worker, WS gateway) → standardize the
  client config in a shared `@cmc/redis` package rather than copy-paste
  the factory.
- Two distinct tenant-scoped consumers exist → promote `redis-keys.ts`
  to a typed builder + lint rule.
- Single-instance Redis becomes the bottleneck → introduce Sentinel for
  HA reads and document the failover behaviour.
- Production deployment to a multi-host cluster → require `rediss://`
  TLS at the application/Vault config layer.

## References

- [PRIORITY_EXECUTION_PLAN.md P0.2](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER.md TD-013](../audit/TECH_DEBT_REGISTER.md)
- [SCALABILITY_REVIEW.md §2.5](../audit/SCALABILITY_REVIEW.md)
- [OBSERVABILITY_REVIEW.md §3](../audit/OBSERVABILITY_REVIEW.md)
