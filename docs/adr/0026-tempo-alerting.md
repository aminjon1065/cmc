# ADR-0026: Distributed tracing (Tempo) + alerting (Alertmanager)

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.8
**Depends on:** ADR-0013 (OTEL tracing), ADR-0014 (Prometheus/Grafana), ADR-0025 (Loki)
**Completes:** the logs / metrics / traces observability triangle

## Context

P0.6 (ADR-0013) already creates OTEL spans and threads `trace_id` into every
log line and audit row — but with no collector, spans were created and dropped.
P0.7 added Prometheus metrics; P1.7 added Loki logs. P1.8 closes the triangle:
**Tempo** stores the traces, the three signals **cross-link** in Grafana, and
**Alertmanager** turns the metrics into an actual alert.

## Decision

### 1. Tempo receives OTLP; no API code change

`Tempo` (obs compose) exposes the OTLP receiver on `:4318` (http) / `:4317`
(grpc). The API already exports OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is
set (ADR-0013, priority-1 exporter) — so pointing it at
`http://localhost:4318` is **pure configuration, no code**. Unset → spans are
still created (trace_id flows to logs/audit) but nothing is exported, exactly
as before. Dev-scale Tempo uses the local filesystem store + 7-day retention;
production swaps for object storage.

### 2. The three signals cross-link

- **Loki → Tempo:** a `derivedFields` rule on the Loki datasource matches the
  `"traceId":"…"` field in a JSON log line and renders it as a one-click link
  to that trace in Tempo. From a log line to its full request trace in a click.
- **Tempo → Loki:** `tracesToLogsV2` on the Tempo datasource links a span back
  to its logs in Loki (filtered by the trace id, ±5 min). From a slow span to
  the lines it emitted.
- **Metrics → both:** Prometheus exemplars are a future add; for now the
  `request_id`/`trace_id` shared keys (ADR-0010/0013) tie the three together by
  query.

This makes the `request_id`/`trace_id` correlation (designed back in P0.3/P0.6)
*navigable*, not just *present*.

### 3. Alertmanager + a 5xx-ratio rule (delivery deferred)

Prometheus now loads `rule_files` and pushes firing alerts to **Alertmanager**:

- **`HighHttp5xxRatio`** — `5xx _count rate / total _count rate > 1%` over 5 m
  (`clamp_min(denominator, 1)` avoids divide-by-zero at low traffic), `for: 5m`.
- **`ApiMetricsTargetDown`** — `up{job="cmc-api"} == 0` for 2 m (the scrape
  target is unreachable).

Alertmanager dedupes/groups and exposes the alerts in its UI (`:9093`). The
**delivery receiver is a deliberate no-op** for now: real paging (Slack /
PagerDuty / a webhook into the platform's notifications) needs a paging target
+ a platform-superadmin recipient model that doesn't exist yet (the same
cross-tenant-admin concept deferred in ADR-0022). The alerting *pipeline* is
complete and visible; wiring a destination is a one-block change in
`alertmanager.yml`.

### 4. Still one stack, one command

Tempo + Alertmanager join Prometheus + Grafana + Loki + Promtail in
`infra/observability-compose.yml`; `pnpm obs:up` brings the whole thing up,
independent of the core infra.

## Consequences

**Positive:**

- The observability triangle is closed: metrics say *what*, traces say *where*,
  logs say *why* — and Grafana links them by trace id.
- Tracing needed **zero API code** — the P0.6 design (export gated on endpoint
  config) paid off; the suite is untouched.
- A real availability alert exists (5xx ratio) + a target-down meta alert,
  evaluated and routed to Alertmanager.
- Verified live: cmc-api traces in Tempo (`GET /incidents`, `POST /auth/login`),
  both rules loaded + evaluating, Prometheus → Alertmanager discovered.

**Negative / known gaps:**

- **No alert delivery** — alerts are visible in the Alertmanager UI but not yet
  paged anywhere (no paging target / platform-superadmin recipient).
- **Filesystem Tempo** — single-node; production needs object storage.
- **No exemplars** — metric → trace jump (Prometheus exemplars) isn't wired;
  correlation today is by shared trace_id in queries.
- **Head sampling only** — all spans exported (fine at this scale); tail-based
  sampling is a later scale concern.
- **Tempo runs as root** in dev to write the named volume — a non-root user +
  pre-chowned volume (or object storage) is the production posture.

## Triggers for re-evaluation

- A paging target exists (Slack/PagerDuty, or platform-superadmin notifications)
  → wire the Alertmanager receiver; add more rules (latency SLO, DB pool).
- Production deploy → object-store Tempo + Loki; non-root Tempo; consider
  Grafana Alloy as the single collector.
- Trace volume grows → tail-based sampling + a sampling policy.

## References

- [PRIORITY_EXECUTION_PLAN P1.8](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0013](./0013-otel-tracing.md) — the spans this collects; export gated on endpoint
- [ADR-0014](./0014-prometheus-metrics.md) — the metrics the 5xx rule reads
- [ADR-0025](./0025-log-aggregation.md) — Loki, the trace↔log link's other end
