# ADR-0058: HA introduction — horizontally-scalable API, PgBouncer, advisory-locked singletons, replica/Sentinel topology

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P3.13
**Depends on:** deploy stack + Caddy edge (P0.9/P0.10 / ADR-0016), transactional outbox/relay (P2.1), audit chain/export/projection (P1.11/P1.12/P2.2), retention sweeper (P3.5 / ADR-0050), Redis-backed sessions/rate-limit/RBAC cache (P0/P1.1), realtime fan-out (P2.3)

## Context

ToR §2.3 calls for no single point of failure. P3.13 *introduces* HA: make the
stateless tier genuinely horizontally scalable now, front Postgres with a
connection pooler, ensure background singletons are safe under N instances, and
ship the stateful-tier (Postgres replica, Redis Sentinel) as a documented target
topology. This runs on local docker-compose, not a cloud cluster, so the bar is:
**real + validated** for what validates cleanly locally, **documented sample** for
what needs a real cluster (streaming replication, Sentinel quorum). Two decisions
were confirmed: **pragmatic HA + correctness** (not a full local cluster), and
**replica/Sentinel as compose profiles/configs** (not default-up).

## Decision

### 1. API is horizontally scalable (real)

`infra/deploy-compose.yml`: dropped `container_name` from `api` so
`docker compose up --scale api=N` works; no app port is published. The Caddy API
site uses **dynamic DNS upstreams** (`dynamic a { name api; port 3001; refresh 5s }`,
`lb_policy round_robin`) so it re-resolves the service name to all replica IPs and
load-balances live as replicas come and go. A single instance resolves to one
upstream — unchanged when not scaled.

### 2. Background singletons are safe under N instances

The platform already runs the cross-instance-sensitive jobs under **Postgres
advisory locks** — the outbox→NATS relay, the audit hash-chain sealer, the SIEM
export, and the audit→ClickHouse projection each take `pg_advisory_xact_lock`
before working, so exactly one instance acts per tick. The audit found **one gap**:
the daily **retention sweep** `@Cron` had no lock — under 2× API both instances
would sweep at 02:00 and write duplicate audit rows. Fixed: the scheduled sweep
now takes `pg_try_advisory_xact_lock(40_211_500)` and the loser skips. (The manual
`sweep(tenantId)` endpoint stays lock-free — it's a single, user-initiated call.)
Other N-instance concerns were verified safe: Redis holds sessions / rate-limit /
RBAC cache (shared); every instance runs the NATS fan-out subscriber so realtime
reaches sockets on all instances; BullMQ workers on each instance share the queue.

### 3. PgBouncer connection pooling (real)

A `pgbouncer` service (transaction pooling) fronts Postgres; the API's runtime
`DATABASE_URL` → `pgbouncer:6432`. Transaction pooling is safe because the app
uses only **tx-scoped GUCs** (`set_config(..., is_local := true)` for
`app.tenant_id` / `app.bypass_rls`) and runs the driver with **`prepare: false`**
(no protocol-level prepared statements — verified in `packages/db/src/client.ts`).
The owner/migration path (`DATABASE_OWNER_URL`, low volume) bypasses the pooler.

### 4. Stateful-tier topology (documented sample)

`infra/ha/docker-compose.ha.yml` + `redis-sentinel.conf` + README: Postgres
`pg-primary` streaming WAL to `pg-replica`, PgBouncer fronting the primary, and
Redis `redis-master`/`redis-replica` with a **3-node Sentinel quorum** (quorum 2)
for automatic failover. Brought up standalone; validated with
`docker compose config`. It uses bitnami images for replication legibility — the
README flags that **production Postgres must be PostGIS-capable** (managed HA /
Patroni/Stolon) with the same primary/standby + PgBouncer shape.

### Deferred (documented in the runbook)

- **Read-replica routing** in the app (`DATABASE_REPLICA_URL` + read/write split)
  — the app keeps one `DATABASE_URL` (primary via PgBouncer). The replica is for
  standby/failover; routing reads to it is a later optimization with RLS-GUC care.
- **Redis Sentinel client** in the app (single `REDIS_URL` today).
- Failover automation/fencing, multi-region (P4.6).

## Consequences

- **Good**: the API scales out today behind a load-balancing edge with zero code
  changes; the only multi-instance correctness gap (retention double-sweep) is
  closed; PgBouncer caps Postgres connections under fan-out; the HA target shape
  is captured as runnable, lint-valid compose + a runbook rather than prose.
- **Trade-offs**: Postgres replica + Redis Sentinel are a *sample* (not the
  default stack) and the app doesn't yet consume them (no read routing / Sentinel
  client) — failover is operator-assisted (re-point PgBouncer) pending those
  follow-ups. The sample uses non-PostGIS images for clarity. No automated
  failover test (needs a real cluster).

## Validation

- **App**: `tsc` clean; retention e2e **6/6** (the refactored, advisory-locked
  sweep); full suite **53 suites / 386 tests**, zero regressions.
- **Infra**: `docker compose -f infra/deploy-compose.yml config` and
  `docker compose -f infra/ha/docker-compose.ha.yml config` both exit 0 (the
  3-sentinel YAML anchor expands correctly); `caddy validate` on the Caddyfile →
  *Valid configuration* (dynamic round-robin upstream adapts).
- **Docs**: `docs/runbooks/ha.md` (operate + scale + failover) + `infra/ha/README.md`.
