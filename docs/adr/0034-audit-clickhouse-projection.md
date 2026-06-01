# ADR-0034: Audit-log → ClickHouse projection

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P2.2
**Depends on:** ADR-0033 (ClickHouse), ADR-0029 (audit `seq`), ADR-0030 (cursor-tail pattern)

## Context

The audit log is the platform's security event store, but analytical queries
(counts/rollups over the full history) and long-term retention don't belong on
the OLTP Postgres. P2.5 stood up ClickHouse; P2.2 projects the audit log into it.

## Decision

A **cursor-tail ETL** (not the event bus) projects `audit_log` into ClickHouse.

### Why a cursor ETL, not the event bus

The audit log is a **firehose** — every action writes a row. Publishing each
audit row to NATS would flood the bus for no benefit (no other consumer needs
per-row audit events). The audit log already has a monotonic `seq` (ADR-0029)
and the cursor-tail pattern is proven (the SIEM export, ADR-0030). So
`AuditProjectionService.flush()` reads `audit_log` past the cursor in `seq`
order, bulk-inserts into ClickHouse, and advances the cursor — reusing the
ClickHouse client (ADR-0033) as the sink. A generic `projection_cursors`
(`consumer`, `last_seq`) table tracks position, reusable by future projections.

### Schema

- **`cmc.audit_events`** (`MergeTree`, ordered by `(occurred_at, seq)`): the
  audit log mirrored for analytics (`Nullable(UUID)` tenant/actor for system
  events).
- **`cmc.audit_daily_stats`** (`SummingMergeTree`) + **`audit_daily_stats_mv`**:
  daily counts by `(action, outcome)` — the audit observatory rollup,
  maintained incrementally in ClickHouse.

### At-least-once

`flush()` inserts into ClickHouse then advances the cursor in one privileged tx:
a CH-insert failure rolls the cursor back → re-project; a crash between
CH-insert and cursor-commit re-projects (rare duplicate). Analytics tolerate it;
the cursor keeps the window tiny. (Exactly-once would need a `ReplacingMergeTree`
keyed by `seq`, but that conflicts with the MV's insert-time counting — deferred.)
`flush()` always runs (endpoint / interval / test); the background interval
(`AUDIT_PROJECTION_INTERVAL_SEC`) only starts when ClickHouse is reachable.

### Gating + endpoints

Gated by `CLICKHOUSE_ENABLED` (`ch.active`); the projection idles otherwise.
`GET /v1/audit/projection/status` (cursor, pending, active) +
`POST /v1/audit/projection/flush`, both `tenant:manage`.

## Consequences

**Positive**
- Audit analytics + long-term retention off the OLTP path; the daily-by-action
  rollup is maintained in-database by the MV.
- Reuses the proven cursor-tail pattern (ADR-0030) + CH client (ADR-0033) — small
  net-new surface; `projection_cursors` is reusable for future projections.
- Verified live: 160 Postgres audit rows → 160 ClickHouse `audit_events`; MV
  rolled up `user.login=88, incident.created=15, …`.
- Zero footprint when disabled (noop CH client; interval idle); CH driver never
  loads in jest (faked seam).

**Negative / deferred**
- **At-least-once** (rare duplicate on crash); exactly-once via
  `ReplacingMergeTree` deferred (MV-counting trade-off).
- **`audit_events` retention / TTL** in ClickHouse deferred (the point is long-
  term retention, but a TTL policy for very old data is a later call).
- **Backfill is one big batch-loop** on first run (fine at this scale; bounded by
  `AUDIT_PROJECTION_BATCH_SIZE` per flush).
- Single-shard CH (ADR-0033 caveats).

## Validation

- **Suite**: 223/223, 29 suites. `audit-projection` (4): projects rows + advances
  cursor (correct CH columns, null tenant for system events); idempotent
  re-flush; incremental; status counts — via a faked CH client.
- **Live smoke** (real CH): `POST /v1/audit/projection/flush` → 160 audit rows
  projected; `cmc.audit_events` count = 160 (= Postgres); `audit_daily_stats` MV
  → `user.login 88, incident.created 15, auth.refresh 7, …`.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean.
