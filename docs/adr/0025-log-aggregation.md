# ADR-0025: Log aggregation (Loki + Grafana)

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.7
**Depends on:** ADR-0010 (structured pino logging), ADR-0014 (Prometheus/Grafana)
**Relates to:** ADR-0013 (OTEL trace_id in logs — the join key to P1.8 Tempo)

## Context

P0.3 (ADR-0010) made every log line structured JSON carrying `request_id`,
`trace_id`, `tenantId`, and `userId`. They still only went to stdout, so
chasing a request meant grepping a terminal. P1.7 aggregates them into **Loki**
and adds a **Grafana** logs view that filters by `request_id` — closing the
loop from "an error happened" to "show me every line of that request".

## Decision

### 1. The host-run API ships its own logs (pino-loki), not Promtail

In dev the API runs on the **host** (`pnpm dev`), not in a container, so a
Docker-log scraper can't see it. Instead the API adds a **`pino-loki`
transport** (gated on `LOKI_URL`, exactly like the OTEL exporter is gated on
its endpoint — ADR-0013). When `LOKI_URL` is set, logs fan out to BOTH stdout
(pretty in dev / JSON in prod) AND Loki; when unset, behaviour is **identical
to before** (the 164-test suite is untouched). pino-loki also works when the
API is containerised (deploy compose), so it's the one delivery path
regardless of where the API runs.

The transport is best-effort (`silenceErrors: true`) — a Loki outage never
crashes or blocks the API.

### 2. Promtail scrapes the infra containers (everything except the API)

`Promtail` (in the obs compose) tails the `cmc-*` container stdout via the
Docker socket → Loki, so Postgres/Redis/Mailpit/MinIO logs are in the same
place. It **drops `cmc-api`** — the API self-ships via pino-loki, so scraping
its container too would duplicate every line. Net: one copy of every log,
whoever produces it.

### 3. Labels are low-cardinality; the rich fields stay in the line

Loki indexes by **label**, so labels must be low-cardinality. The pino-loki
labels are static: `app=cmc-api`, `env`. The high-cardinality fields
(`requestId`, `tenantId`, `userId`, `traceId`) live **inside the JSON log
line** and are queried with LogQL `| json | requestId="…"`. Making them labels
would explode Loki's index — the classic Loki anti-pattern, avoided here.

### 4. Grafana: a provisioned Loki datasource + a `request_id` logs dashboard

A `Loki` datasource (`cmc-loki`) is provisioned alongside the existing
Prometheus one. A checked-in **CMC · Logs** dashboard has: an API log-rate-by-
level bar panel, an **API logs panel filtered by `request_id` / `tenant` /
free-text** (textbox template vars), and an infra-container logs panel. Drop a
request_id in and you get exactly that request's lines.

### 5. Dev-scale Loki; separate compose

Loki runs single-binary with the **filesystem** store and a 7-day retention —
fine for dev. Production swaps the filesystem for object storage (S3/MinIO).
It lives in `infra/observability-compose.yml` (with Prometheus + Grafana), so
the whole observability stack is `pnpm obs:up` / `obs:down`, independent of the
core infra.

## Consequences

**Positive:**

- request_id → every log line of that request, in Grafana. The audit row, the
  trace, and now the logs all key on the same `request_id`.
- One delivery path per producer (pino-loki for the API, Promtail for
  containers) — no duplicates.
- Zero behaviour change when `LOKI_URL` is unset — opt-in, suite untouched.
- Low-cardinality labels keep Loki healthy; rich fields stay queryable via
  `| json`.

**Negative / known gaps:**

- **No alerting on logs** yet (e.g. error-rate alerts) — Grafana/Loki ruler is
  future work.
- **Filesystem store** — single-node, not HA; production needs object storage.
- **No log-based metrics** (LogQL metric queries beyond the dashboard) wired
  into Prometheus.
- **Trace↔log↔metric** correlation completes when Tempo lands (P1.8) — the
  `traceId` field is already in every line for the derived-field link.
- **pino-loki batches** (5s) — a crash within the window can lose the last
  un-flushed batch from Loki (stdout still has it).

## Triggers for re-evaluation

- P1.8 Tempo → add a Loki→Tempo derived-field link on `traceId`; one click from
  a log line to its trace.
- Production deploy → point Loki at S3/MinIO; consider Grafana Alloy if the
  agent surface grows.
- Need alerts → enable the Loki ruler or Grafana alerting on log queries.

## References

- [PRIORITY_EXECUTION_PLAN P1.7](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0010](./0010-structured-logging.md) — the structured logs this aggregates
- [ADR-0014](./0014-prometheus-metrics.md) — the Prometheus/Grafana stack extended
- [ADR-0013](./0013-otel-tracing.md) — trace_id in logs, the P1.8 join key
