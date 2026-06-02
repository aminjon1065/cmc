# ADR-0036: Dashboard analytics from ClickHouse

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.6
**Depends on:** ADR-0033 (ClickHouse analytics plane), ADR-0023 (incidents)

## Context

The dashboard's snapshot widgets (active counts, by-region, by-type, priority
list) already serve **real** data from the OLTP path (`/incidents/stats`,
`/incidents`) since P1.5c. What it lacked was **historical trend** — the kind of
time-series rollup that doesn't belong on the OLTP Postgres. P2.5 stood up the
ClickHouse analytics plane (incident events → `incident_daily_stats_by_region`
MV); P2.6 surfaces it on the dashboard.

## Decision

A `DashboardAnalyticsService` (in `AnalyticsModule`, alongside the CH client)
reads the daily-by-region MV and returns a **daily incident trend** over a
window; the web dashboard renders it as a bar chart.

### Endpoint under `/v1/analytics`, not `/v1/metrics`

`GET /v1/analytics/dashboard?days=N` (gated `incident:read`). The plan sketched
`/v1/metrics/…`, but `/metrics` is already the (unversioned) Prometheus scrape
endpoint (P0.7) — `/v1/analytics/*` avoids the overload and sits naturally with
the analytics plane. The window defaults to 14 and is **clamped 1–90**.

### Tenant-scoped query (ClickHouse has no RLS)

CH enforces no row security, so the service scopes every query with
`WHERE tenant_id = '<id>'`. The `tenantId` always comes from the verified
request context; it's additionally asserted to match a UUID before interpolation
(defence in depth — no user-controlled value reaches the SQL). The day column is
aliased to `bucket` (not `day`) so the `String` projection never collides with
the `Date` column in `GROUP BY` / `ORDER BY` (ClickHouse raises a supertype error
otherwise).

### Gap-filled in code, graceful when unavailable

The MV only has rows for days with incidents; a pure `buildDailyTrend(rows,
days, today)` fills the window to a continuous, zero-padded series (oldest →
newest) — deterministic (today injected) and unit-tested. When ClickHouse is
disabled/unreachable (`ch.active === false`) the service returns
`source: "unavailable"` with an empty trend, and the dashboard shows "analytics
unavailable" instead of breaking — same posture as the existing snapshot fetch.

## Consequences

**Positive**
- First ClickHouse-backed **UI**, end-to-end: incident → projection → MV →
  `/v1/analytics/dashboard` → dashboard bar chart. Historical analytics stay off
  the OLTP path.
- Reuses the CH client (ADR-0033) and the daily MV (P2.5) — small net-new
  surface; the trend helper is pure + testable; CH driver never loads in jest
  (faked seam).
- Verified live: baseline `total=2` (today=2) → create incident → `total=3`
  (today 2→3), tenant-scoped, 14 gap-filled points.

**Negative / deferred**
- **String-interpolated `tenant_id`** (UUID-asserted, context-sourced — safe);
  parameterised CH binding would require widening the client interface (deferred).
- **One widget (incident trend).** More CH-backed metrics (by-region trend,
  audit activity, MTTR) are follow-ons.
- **No realtime refresh** — the dashboard reads on load; live updates via the
  P2.3 WebSocket plane are a follow-on.
- Single-shard CH (ADR-0033 caveats).

## Validation

- **Suite**: 244/244, 31 suites. `dashboard-analytics` (7): pure `buildDailyTrend`
  gap-fill; `source=unavailable` when CH off; HTTP — gap-filled tenant-scoped
  trend (query asserts tenant + MV table), window clamp (default 14 / max 90),
  401 unauth, 403 without `incident:read`.
- **Live smoke** (real CH): `GET /v1/analytics/dashboard?days=14` → `source=clickhouse`,
  14 points; create incident → today's bucket `2 → 3`.
- **Build/lint**: API `tsc`/`nest build`/`eslint` + web `tsc`/`eslint`/`next build`
  clean. No migration (read-only over existing CH tables).
