# ADR-0015: Health probes — liveness / readiness / deep

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.8
**Closes tech-debt:** TD-010
**Depends on:** ADR-0008 (Redis), ADR-0001 (Postgres + MinIO)

## Context

`GET /health` existed from the first commit but was **liveness only** — a
static `{ status: "ok" }` that never touched a dependency. TD-010 (S1)
flagged the consequence: a Kubernetes readiness probe or load-balancer
health check pointed at it would route traffic to an instance whose
Postgres / Redis / MinIO is unreachable, because the probe answers 200
regardless. ToR §14.8 differentiates four probe tiers; P0.8 lands the
three that matter now: **liveness, readiness, deep**.

## Decision

### 1. Three endpoints, three jobs

| Endpoint | Auth | Touches deps | HTTP semantics | Consumer |
|---|---|---|---|---|
| `GET /health` | none | no | always 200 | liveness — "is the process alive?" |
| `GET /health/ready` | none | yes (parallel) | **200 ready / 503 not_ready** | readiness — LB / orchestrator routing |
| `GET /health/deep` | JwtAuthGuard | yes (parallel) | always 200 | operator/runbook diagnostics |

**Liveness never touches a dependency** — deliberately. A liveness probe
that fails on a transient DB blip makes the orchestrator kill a pod that
would have recovered. Liveness answers "the event loop is turning"; only
readiness answers "the deps are reachable." Verified live: with a dead S3
endpoint, `/health` still returns 200 while `/health/ready` returns 503.

### 2. Readiness returns the status code, not just a body

`/health/ready` sets **HTTP 200 when every dependency is up, 503
otherwise**, so a load balancer can route on the status code alone
without parsing JSON. The body still lists per-dependency up/down for a
human glancing at it, but it is intentionally **lean** — no timings, no
error strings — because readiness is polled frequently by infra and
should be cheap and leak nothing.

### 3. Deep is the diagnostic surface — timings + errors, always 200

`/health/deep` returns per-dependency `{ status, latencyMs, error? }` and
an overall `ok | degraded`. It always returns 200: it is a diagnostic
read, not a routing signal. `latencyMs` is the round-trip of each probe
(useful for "Redis is up but slow"); `error` carries the failure message
when a dep is down.

### 4. Probes use clients/services + run in parallel + are timeout-bounded

- **Postgres:** `client\`select 1\`` on the raw postgres-js client — a pure
  connectivity check that bypasses RLS / tenant scope (a readiness probe
  must not depend on request or tenant context).
- **Redis:** `ping()`, asserting the reply is `PONG`.
- **MinIO:** `StorageService.probeReachable()` → a `HeadObject` on a
  sentinel key. The key need not exist: a not-found still proves MinIO is
  reachable AND credentials are accepted (a 403 or a connection failure
  throws). `HeadObject` (not `HeadBucket`) is used because it is the
  command the documents module already exercises, it is S3-generic (works
  against AWS S3 unchanged), and it avoids an aws-sdk lazy-`import()`
  quirk — see §8.

All three run via `Promise.all` — total latency is the slowest single
probe, not their sum. Each is wrapped in `Promise.race` against a
`HEALTH_PROBE_TIMEOUT_MS` timer (default **2000ms**). This is the
load-bearing safety property: **a hung dependency can never hang the
probe endpoint**, which would otherwise make an orchestrator conclude the
whole API is wedged and cascade a restart storm. The timeout's `setTimeout`
is always cleared in a `finally` so a fast probe leaks no timer.

### 5. `/health/deep` auth: authenticated now, role-gated at P1.1

The plan called `/health/deep` "admin-only." RBAC does not exist yet
(P1.1), so there is no `tenant_admin` / `platform_admin` role to gate on.
The available boundary today is **authentication** (`JwtAuthGuard`,
which requires a valid access token → tenant context). That is the honest
interim: deep timings + dependency error strings are mildly sensitive, so
they require a logged-in caller, and true role-restriction is a one-line
guard swap once RBAC lands. Documented as a deliberate gap rather than
shipping a fake "admin" check.

### 6. MinIO probe goes through StorageService, not the raw S3 token

`HealthService` injects `StorageService` (the StorageModule's public
export), not the `S3_INTERNAL` provider symbol. StorageModule is
`@Global()` but exports only `StorageService` — injecting the raw token
from another module fails DI resolution. Adding a `probeReachable()`
method to `StorageService` keeps HealthService depending on the module's
public surface, which is the correct boundary anyway.

### 7. No pollution of the system's own signals

- `MetricsMiddleware` (P0.7) already excludes `/health` and `/health/*`
  from the RED histogram.
- pino `autoLogging` already ignores `/health` and `/health/ready` (the
  high-frequency LB pollers); `/health/deep` IS logged (human-invoked,
  low frequency, worth a log line).

### 8. Test note: the aws-sdk + jest VM-modules flag

The MinIO probe (any aws-sdk v3 command send) triggers a lazy `import()`
that jest's VM-modules runtime can only resolve when the process runs
with `NODE_OPTIONS=--experimental-vm-modules`. The `pnpm test:e2e` script
already sets this; a bare `jest health` invocation that omits it makes the
S3 probe throw `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG` and the
readiness/deep tests fail spuriously. This is a test-harness artifact, not
a runtime issue — production `node dist/main.js` has no such constraint.
Always run the suite via `pnpm test:e2e`.

### 9. Contracts are shared types

`ReadinessResponse`, `DeepHealthResponse`, `DependencyStatus`, and
`HealthDependencyName` live in `@cmc/contracts` (built to `dist`,
consumed by the API), so a future web/SDK consumer shares the exact
shape.

## Consequences

**Positive:**

- TD-010 retired. A real readiness signal exists — orchestrators and LBs
  can stop routing to instances with broken deps.
- The deep probe gives an operator a one-call "what's slow / what's down"
  with latencies, without shelling into the box.
- Timeout-bounding means a single wedged dependency degrades one probe
  line, not the whole endpoint.
- Verified live: `/health/ready` → 200 with all-up; with a dead S3
  endpoint → **503 + minio down** (postgres/redis still up, returned
  promptly under the timeout); `/health/deep` → 401 unauthenticated, 200
  with per-dep timings authenticated. Full e2e suite **73/73**.

**Negative / known gaps:**

- **`/health/deep` is authenticated, not admin-restricted.** Awaits P1.1
  RBAC (§5). Any authenticated user can currently read dependency timings.
- **No `/health/startup` probe.** ToR §14.8 lists it; not needed until a
  slow-boot path (large migrations) exists. Liveness + readiness cover
  the current deployment model.
- **No synthetic external monitor.** A cron that hits `/health/ready` from
  off-host is an H1 item (OBSERVABILITY_REVIEW §5.3).
- **MinIO probe is a HeadObject on the files bucket only.** Doesn't check
  the backups bucket or write-ability — connectivity + auth is the
  readiness-relevant signal; deeper storage checks aren't warranted.
- **Readiness is unauthenticated and reveals dep up/down.** Acceptable —
  it leaks no data, only "the platform is/ isn't ready", which an LB must
  see. Network-restrict at the proxy (P0.9) alongside `/metrics`.

## Triggers for re-evaluation

- RBAC lands (P1.1) → swap `JwtAuthGuard` on `/health/deep` for a
  role guard (`platform_admin` / `tenant_admin`).
- A slow-boot path appears → add `/health/startup`.
- More dependencies arrive (NATS P2.1, ClickHouse P2.5, OpenSearch P3.6)
  → add a probe each; the `runAllProbes` array is the single edit point.
- Deploy to k8s → wire `/health` to livenessProbe, `/health/ready` to
  readinessProbe, tune `HEALTH_PROBE_TIMEOUT_MS` vs probe period.

## References

- [PRIORITY_EXECUTION_PLAN P0.8](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-010](../audit/TECH_DEBT_REGISTER.md)
- [OBSERVABILITY_REVIEW §5 (health probes)](../audit/OBSERVABILITY_REVIEW.md)
- [ADR-0008](./0008-redis-tier-1-dependency.md)
- ToR §14.8 (liveness / readiness / startup / deep)
