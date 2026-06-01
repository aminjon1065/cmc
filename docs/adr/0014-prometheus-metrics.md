# ADR-0014: Prometheus metrics (/metrics) + first dashboard

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.7
**Closes tech-debt:** TD-009 (no metrics endpoint)
**Depends on:** ADR-0013 (OTEL tracing — the sibling observability pillar)
**Unblocks:** P1.8 (Alertmanager rules consume these series)

## Context

P0.6 (ADR-0013) gave the platform traces. P0.7 closes the second missing
observability pillar from the OBSERVABILITY_REVIEW: **metrics**. Before
this, the only signal a Prometheus could see was nothing — no
`/metrics`, no client library. TD-009 flagged it S1; the review called
RED-per-route the "first capacity signal."

This ADR lands: a prom-client registry, RED HTTP metrics + DB-saturation
metrics + Node process metrics, an anonymous `GET /metrics` endpoint, a
Prometheus + Grafana compose stack scraping the host-run API, and one
checked-in Grafana dashboard.

## Decision

### 1. `prom-client` directly, not the OTEL metrics SDK

P0.6 already runs `@opentelemetry/sdk-node` for traces, and OTEL has a
metrics API + Prometheus exporter. We chose **`prom-client`** instead:

- It is the de-facto Node Prometheus library — `collectDefaultMetrics`
  gives Node process metrics (event-loop lag, heap, GC, CPU) for free,
  which the OTEL metrics path does not match in breadth.
- The histogram/counter/gauge API is direct and synchronous; no
  meter-provider indirection for what is a small, explicit metric set.
- The OTEL metrics pipeline (push to a collector) is a heavier model
  than Prometheus's pull; pull fits a single host-run API perfectly.

Trade-off: traces flow through OTEL, metrics through prom-client — two
libraries. Accepted: they observe different signals, the
`service="cmc-api"` label + `service.name` resource keep them joinable,
and a future migration to OTEL metrics (if a collector-push model is ever
needed) is localized to `MetricsService`.

### 2. A dedicated Registry, not the global default

`MetricsService` constructs its **own** `new Registry()` and binds every
metric (including `collectDefaultMetrics`) to it. This is load-bearing
for tests: jest builds the Nest app once per e2e suite in a shared worker
process, and the global default registry would throw "metric already
registered" on the second build. A per-service registry sidesteps that
entirely.

### 3. Metric families

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | method, route, status_code | **RED** — Rate via `_count`, Errors via `status_code`, Duration via buckets. One histogram covers all three. |
| `cmc_db_transactions_in_flight` | gauge | — | DB **saturation** — concurrent transactions right now. |
| `cmc_db_transactions_total` | counter | scope, outcome | DB throughput + error rate by tenant/privileged and commit/error. |
| `cmc_db_pool_max` | gauge | — | The pool ceiling, so a dashboard can draw in-flight ÷ max. |
| `process_*`, `nodejs_*` | various | — | Node defaults (event-loop lag, heap, GC, CPU). |

### 4. DB saturation = in-flight transactions (postgres-js has no pool API)

The OBSERVABILITY_REVIEW asked for `db_connections_in_use` /
`db_connections_idle`. **postgres-js (porsager) exposes no public live
pool-stat API** — there is no supported accessor for "connections
currently checked out." So instead of shipping a metric that reads a
private field (brittle across versions), P0.7 measures **transactions
in flight** at the single chokepoint (`TenantDatabaseService.withSpan`,
shared by `runForTenant` + `runPrivileged`). This is the honest
saturation signal the platform can actually observe: every transaction
borrows exactly one pooled connection for its duration, so in-flight
transactions ≈ connections in use, bounded by `cmc_db_pool_max`. Dividing
the two gives pool-utilisation for the P1.8 alert rule. Documented as a
known approximation; revisit if we migrate to node-`pg` (which does
expose `totalCount`/`idleCount`/`waitingCount`).

### 5. Route label normalisation (cardinality guard)

The middleware records `req.route.path` — the **matched route pattern**
(`/auth/sessions/:id`), read inside the `finish` callback after routing
resolves — never the concrete URL. A request with a UUID path param
yields `route="/auth/sessions/:id"`, not the id. Unmatched requests (404s,
scanners) collapse to a single `route="<unmatched>"` bucket. This keeps
label cardinality bounded no matter what a bot throws at the host. The
e2e suite asserts a concrete UUID never appears in the exposition.

The exclusion of `/metrics` and `/health*` uses **`req.originalUrl`**, not
`req.path` — a NestJS gotcha that cost a debugging cycle: Nest mounts
consumer middleware on an internal sub-router that rewrites `req.url` /
`req.path` to be relative to the mount point, so `req.path` reads `/`
inside the middleware and the exclusion silently never matches.
`req.originalUrl` is the full, un-rewritten path and is immune. The
endpoints that exist to observe the system therefore stay out of the
system's own RED signal.

### 6. Timing on `finish`, middleware first

`MetricsMiddleware` is the **first** middleware in the chain, so its
`process.hrtime.bigint()` timer brackets the entire request — including
request-context + tenant-context setup. It records on the response
`finish` event, by which point `status_code` and `req.route` are known.

### 7. `GET /metrics` — anonymous, unversioned, proxy-restricted

The scrape endpoint mirrors `GET /health`: no auth, not under the `/v1`
public surface (the scrape contract is operational, not API). Exposure
posture: open on the app listener, to be **network-restricted at the
reverse proxy** (P0.9 Caddy) and never published to the public listener
in production — same treatment as the Postgres/Redis ports. `METRICS_ENABLED`
gates *recording* (every observe call no-ops when false) without removing
the route, so it can be silenced cheaply.

### 8. Prometheus + Grafana in a separate compose file

`infra/observability-compose.yml` (`pnpm obs:up/down/logs/reset/ps`) is
**separate** from the core `infra/docker-compose.yml` so the metrics
stack is independently toggled. The API runs on the host (app Dockerfiles
are P0.10), so Prometheus scrapes `host.docker.internal:3001`
(`extra_hosts: host-gateway` makes that resolve on Linux too). Grafana
auto-provisions the Prometheus datasource and loads dashboards-as-code
from `infra/observability/grafana/dashboards/`. Ports: Prometheus 9090,
Grafana 3002 (host) — chosen to dodge web (3000), API (3001), MinIO
(9000/9001).

### 9. First dashboard: `cmc-api-red.json`

Three rows: **HTTP (RED)** — request rate by route, 5xx error ratio (red
threshold at 1%), P50/P95/P99 latency, requests by status class;
**Database** — in-flight vs pool max, tx rate by scope/outcome;
**Node process** — event-loop lag p99, heap used, CPU cores. Checked into
the repo so it is versioned and provisioned automatically, not clicked
together by hand.

## Consequences

**Positive:**

- TD-009 retired. The platform emits RED-per-route, DB saturation, and
  Node health, scrapable today.
- P1.8 (Alertmanager) is unblocked — its starter rules (5xx ratio,
  P95 latency, DB pool > 80%) read these exact series.
- Dashboards-as-code: `git` is the source of truth for the first
  operational view.
- The `service` label + OTEL `service.name` keep metrics joinable with
  traces (P0.6) and logs (P0.3) for a single pane.

**Negative / known gaps:**

- **Two telemetry libraries** (OTEL traces + prom-client metrics).
  Accepted per §1.
- **DB metric is transaction-in-flight, not connection-level.**
  Approximation per §4; exact pool stats await a node-`pg` migration.
- **No business metrics yet** (active sessions, documents, login
  outcomes). The review lists them; they land per-module at P1.x.
- **`tenant_id` is not a label.** Deliberately — it is unbounded
  cardinality at H2+. Per-tenant breakdown waits for the H1 cardinality
  decision (Thanos/Mimir or OTEL per-tenant streams).
- **No alerting on these metrics yet** — Alertmanager is P1.8.
- **/metrics is unauthenticated.** Mitigated by proxy restriction (P0.9);
  documented, not yet enforced because no proxy exists.
- **Scrape target is `host.docker.internal`.** Correct while the API runs
  on the host; becomes a compose-service DNS name once app Dockerfiles
  land (P0.10).

## Triggers for re-evaluation

- App Dockerfiles land (P0.10) → change the Prometheus target from
  `host.docker.internal:3001` to the compose service name, and consider
  merging the obs stack into the main compose.
- Per-tenant metrics needed → make the H1 cardinality decision before
  adding `tenant_id` as a label.
- Migrate to node-`pg` → replace the in-flight approximation with real
  `totalCount`/`idleCount`/`waitingCount` pool gauges.
- A second service appears → give it the same `MetricsService` shape and
  a distinct `service` label; add a scrape job.
- Metric volume/cardinality grows → introduce recording rules + Thanos/
  Mimir for long-term storage.

## References

- [PRIORITY_EXECUTION_PLAN P0.7](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-009](../audit/TECH_DEBT_REGISTER.md)
- [OBSERVABILITY_REVIEW §3 (metrics), §9 (dashboards)](../audit/OBSERVABILITY_REVIEW.md)
- [ADR-0013](./0013-otel-tracing.md) — traces, the sibling pillar
- ToR §14.1 (metrics), §14.7 (operational dashboards)
