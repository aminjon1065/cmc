# Runbook: High Availability (P3.13 / ADR-0058)

How the CMC platform runs without a single point of failure, and how to operate
the HA tiers. Scope: an *introduction* to HA — the stateless tier is genuinely
horizontally scalable today; the stateful tier (Postgres, Redis) ships as a
documented target topology you can stand up and study.

## TL;DR topology

```
            ┌──────────────┐
   clients ─┤  Caddy (edge) │  TLS, HSTS, /metrics+/health/deep blocked
            └──────┬───────┘
        DNS round-robin (dynamic upstreams, refresh 5s)
            ┌──────┴───────┐
        ┌───┤  api × N      ├───┐        stateless — scale freely
        │   └──────────────┘   │
        ▼                      ▼
   PgBouncer (txn pool)    Redis (Sentinel-fronted)
        │                      │
   Postgres primary ──WAL──▶ standby
```

## 1. Stateless tier — `api × N` behind Caddy (real, today)

`infra/deploy-compose.yml`:

- The `api` service has **no `container_name`**, so it scales:
  ```bash
  pnpm infra:up                       # core data services on cmc-net
  JWT_SECRET=… AUTH_SECRET=… APP_HOST=… API_HOST=… \
    docker compose -f infra/deploy-compose.yml up -d --scale api=2
  ```
- **Caddy load-balances** across the replicas via Docker DNS (`dynamic a` upstream,
  `lb_policy round_robin`, re-resolved every 5 s) — see `infra/caddy/Caddyfile`.
  No app port is published; only Caddy is exposed.

### Why N× API is safe (no shared in-process state)

- **Sessions / rate-limit / RBAC cache** live in Redis (shared) — not in process.
- **Realtime WS**: a socket lives on one instance, but every instance runs the
  NATS fan-out subscriber, so an event published by any instance reaches the
  sockets on all instances. Correct across replicas.
- **Queues** (BullMQ previews/imports): workers on every instance pull from the
  shared queue — work is distributed, not duplicated.
- **Background singletons are guarded by Postgres advisory locks** so exactly one
  instance does the work each tick:
  | job | lock |
  |---|---|
  | outbox→NATS relay | `pg_advisory_xact_lock` (relay.service) |
  | audit hash-chain sealer | `pg_advisory_xact_lock` (audit-chain) |
  | audit SIEM export | `pg_advisory_xact_lock` (audit-export) |
  | audit→ClickHouse projection | `pg_advisory_xact_lock` (audit-projection) |
  | **retention sweep (daily cron)** | `pg_try_advisory_xact_lock` (P3.13) |

  When adding a new interval/cron that mutates shared state, **take an advisory
  lock** (keys live at `40_211_x00`).

## 2. Connection pooling — PgBouncer (real, today)

`infra/deploy-compose.yml` runs **`pgbouncer`** (transaction pooling) in front of
Postgres; the API's runtime `DATABASE_URL` points at `pgbouncer:6432`. Transaction
pooling is safe because the app uses only **tx-scoped GUCs**
(`set_config(..., is_local := true)` for `app.tenant_id` / `app.bypass_rls`) and
runs the driver with **`prepare: false`** (no protocol-level prepared statements).

- The owner/migration path (`DATABASE_OWNER_URL`, low volume) deliberately
  **bypasses** the pooler and talks to Postgres directly.
- Run migrations against Postgres directly (not through PgBouncer).

## 3. Stateful tier — Postgres primary/standby + Redis Sentinel (sample)

`infra/ha/docker-compose.ha.yml` is the **target topology** (bring up standalone):

```bash
docker compose -f infra/ha/docker-compose.ha.yml config     # lint
docker compose -f infra/ha/docker-compose.ha.yml up -d
```

- **Postgres**: `pg-primary` streams WAL to `pg-replica` (async by default; set a
  synchronous standby for RPO 0). PgBouncer fronts the primary. Production must
  use a **PostGIS-capable** HA Postgres (managed service, or Patroni/Stolon) with
  the same primary/standby + PgBouncer shape — the sample uses bitnami images for
  legibility of the *topology*, not as the prod image.
- **Redis**: `redis-master` + `redis-replica` + a **3-node Sentinel** quorum
  (`mymaster`, quorum 2) for automatic master failover. See
  `infra/ha/redis-sentinel.conf`.

### Deferred (documented, not yet wired in the app)

- **Read-replica routing** — the app keeps a single `DATABASE_URL` (writes +
  reads to the primary via PgBouncer). Routing read-only/analytics queries to the
  standby needs a `DATABASE_REPLICA_URL` + read/write split + careful RLS-GUC
  handling on the replica; a future optimization.
- **Redis Sentinel client** — the app uses a single `REDIS_URL`. Consuming
  Sentinel for automatic Redis failover needs the ioredis Sentinel client
  config; a future change.
- **Failover automation / fencing**, multi-region (P4.6).

## 4. Failover behaviour (sample tier)

- **An `api` replica dies** → Caddy stops routing to it within ~5 s (next DNS
  refresh / `lb_retries`); other replicas serve. No user impact beyond in-flight
  requests to that pod.
- **Postgres primary dies** → the standby holds the latest streamed WAL; promote
  it (managed service does this automatically; with Patroni it's automatic).
  Re-point PgBouncer `DB_HOST` at the new primary. App needs no change.
- **Redis master dies** → Sentinel promotes a replica after `down-after`
  (5 s) + quorum; a Sentinel-aware client follows the new master automatically
  (pending the client change above).

## 5. Verify locally

```bash
docker compose -f infra/deploy-compose.yml config     # deploy stack lints
docker compose -f infra/ha/docker-compose.ha.yml config
# after `--scale api=2`: two API containers, Caddy LBs across them
docker compose -f infra/deploy-compose.yml ps
```
