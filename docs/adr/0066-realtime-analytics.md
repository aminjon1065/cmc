# ADR-0066: Realtime analytics — ClickHouse-native Z-score anomaly detection + proactive alerts

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.8 (a — detector + endpoint; b — web widget + proactive alerting)
**Builds on:** ClickHouse projections (P2.5 incidents, P2.2 audit), dashboard trend (P2.6), notifications (P1.6)
**Reshapes scope of:** the original "P4.8 — Realtime analytics (ClickHouse Live Views **or Flink**)"

## Context

Incident/audit time-series already flow into ClickHouse (P2.5/P2.2 projections;
P2.6 reads the daily trend). ToR §4 wants **realtime analytics with anomaly
detection**. The original P4.8 floated **Flink**, but Flink is a heavy stateful
JVM streaming substrate that doesn't fit the single-site, headless-tested reality
(same call as Linkerd in P4.7). So P4.8 is **ClickHouse-native**.

## Decision

### 1. A pure, deterministic Z-score detector (P4.8a)

`detectAnomalies(series, {window, zThreshold, minStddev})` computes, for each
point from index `window` on, the rolling mean + stddev of the preceding
`window` points and flags |z| ≥ `zThreshold`. `minStddev` is a **floor** (not a
skip): a flat/quiet baseline neither divides-by-zero nor flags single-unit noise,
yet a real jump off it still trips — the "spike out of nowhere" a crisis board
cares about. No I/O, no `Date` → unit-tested in isolation.

### 2. CH-backed endpoint, gated + degrading (P4.8a)

`DashboardAnalyticsService.anomalies(tenantId, {days,window,zThreshold})` pulls
the tenant-scoped daily incident series from ClickHouse (`incident_daily_stats_by_region`),
**gap-fills via `buildDailyTrend`** (so quiet days register as dips), and runs the
detector. `GET /v1/analytics/anomalies` (`@Authorize("incident:read")`,
query `days`/`window`/`z`). When ClickHouse is off it degrades to
`source:"unavailable"` (no hard dependency), exactly like the trend.

### 3. Proactive alerting, gated + deduped (P4.8b)

`AnomalyAlertService` runs a background scan (gated on
`ANALYTICS_ANOMALY_DETECTOR_ENABLED` **and** ClickHouse active; interval skipped
under jest — `scan()` is called directly in tests). Per tenant it runs the
detector, keeps only anomalies from the last `RECENT_DAYS` (so the first run
doesn't replay the whole backfill), and for each **new** one fans an
`analytics.anomaly` notification (P1.6) out to `monitoring:read` holders —
**deduped once per (tenant, day, direction)** via a Redis key (`SET NX EX`). The
web **dashboard widget** is server-seeded and polls `/v1/analytics/anomalies`
every 60s (BFF; no JWT in the browser), consistent with the platform's polling
posture (monitoring, chat).

## Consequences

- **Positive:** reuses the existing CH substrate (no new infra); the detector is
  deterministic + e2e-tested; the endpoint degrades gracefully; alerts are
  proactive yet deduped + permission-scoped; the access JWT stays server-side.
- **Negative / trade-offs:** granularity is **daily** incident volume (not
  sub-second streaming) and delivery is near-realtime **polling** — fine at this
  scale, and Flink/true-streaming is the documented follow-on; one signal
  (incident volume) for now (audit-rate / case-volume anomalies are follow-ons);
  thresholds are global defaults (per-tenant tuning = follow-on); the real CH
  query + the live interval are a **manual/live boundary** (headless fakes CH).

## Validation

- e2e `analytics-anomalies` **9/9** (pure spike/dip/flat/short; CH-off → unavailable;
  faked-CH endpoint spike + custom-z + 401 + 403) and `analytics-anomaly-alert`
  **1/1** (new anomaly → `analytics.anomaly` notification to a `monitoring:read`
  holder; re-scan deduped). Full backend suite **62 suites / 442 tests**, zero
  regressions; `tsc`/eslint clean; web `tsc`/`lint`/`build` green.
- **Boundary:** real ClickHouse + the live detector interval = manual live-smoke.

## Files

- Backend: `apps/api/src/modules/analytics/anomaly-detector.ts` (pure),
  `dashboard-analytics.service.ts` (`anomalies()`), `analytics.controller.ts`
  (`GET /anomalies`), `anomaly-alert.service.ts` (proactive scan) + module wiring;
  `packages/contracts/src/analytics.ts` (`AnomalyPoint`/`AnomaliesResponse`),
  `notification.ts` (`analytics.anomaly` kind); config
  `ANALYTICS_ANOMALY_DETECTOR_ENABLED`/`ANALYTICS_ANOMALY_INTERVAL_SEC`.
- Web: `apps/web/src/app/dashboard/anomalies-widget.tsx` + `actions.ts`, wired
  into `dashboard/page.tsx`.

## Follow-ons

- Flink / true streaming (CH Live/Refreshable Views) if sub-second is ever needed.
- More signals: audit-event rate, case volume, per-region anomalies.
- Per-tenant thresholds + an admin-tunable config; ML-based detection.

> Closes **Horizon P4** (Advanced platform). P4.4 (Mobile companion) remains
> deferred (PWA-vs-native decision pending). Next: **P5 — National scale**.
