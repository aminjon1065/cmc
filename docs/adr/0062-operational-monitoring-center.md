# ADR-0062: Operational Monitoring Center — polled wall snapshot, audit_log replay

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.3 (a — backend; b — wall view; c — time-replay)
**Depends on:** incidents (P1.5), audit_log (P1.11), video rooms (P4.2), RBAC (P1.1), BFF posture

## Context

The UI always implied a "Command Center" (the disabled sidebar entry, a hardcoded
"ELEVATED ALERT" hero ribbon) but nothing backed it. ToR §3.26 wants an
operational wall: live situational tiles, an alert ticker, and time-replay of the
event log for after-action review.

The data already exists across the platform (incidents, audit_log, video rooms,
the P2.3 realtime plane). The questions were how the browser gets live data
(without holding the access JWT), and what to replay.

## Decision

### 1. A server-aggregated snapshot the browser polls (P4.3a/b)

Rather than have the web stitch several endpoints or open a second authenticated
WebSocket, the API exposes **one** aggregation: `GET /v1/monitoring/summary`
(`@Authorize("monitoring:read")`) returning incidents `active`/`byStatus`/
`bySeverity`, recent incidents, recent `audit_log` events (the ticker feed), and
the open video-room count. The web **polls it every 4s** through the normal BFF —
consistent with chat's polling and keeping the access JWT server-side. Real WS
push (via a P2.3 WS-ticket) is a deliberate follow-on, not needed for the MVP.

`MonitoringService` is **pure Postgres** (RLS-scoped) on purpose: no ClickHouse
dependency, so the wall is always available even when the analytics projections
are off, and it is fully e2e-testable.

### 2. Time-replay from audit_log (P4.3a/c)

`GET /v1/monitoring/replay?from=&to=&limit=` returns the `audit_log` action
timeline over a window, ascending, capped at 2000. `audit_log` (not ClickHouse
`incident_events`) was chosen as the replay source: it is always-on, durable in
Postgres, covers **all** domains (incidents, cases, video, …), and is e2e-
testable without ClickHouse — and it is exactly the operational "who did what,
when" record an after-action replay wants. The web `ReplayPanel` loads a window,
then a scrubber (or Play) steps through events as they happened.

### 3. A dedicated `monitoring:read` permission

The whole OMC is gated on a new `monitoring:read` (granted to operator, auditor,
tenant_admin) — a clean single gate for the wall + replay, rather than overloading
`incident:read`.

## Consequences

- **Positive:** the "Command Center" sidebar entry is now real; one polled
  endpoint drives the wall; replay reuses the tamper-evident audit log; no new
  heavy infra; access JWT stays server-side.
- **Negative / trade-offs:** polling (4s) is near-real-time, not instant — a
  WS-ticket push path is the follow-on; the wall's counts are point-in-time
  aggregations (fine at this scale, would move to ClickHouse materialised views
  for very large tenants); replay is capped at 2000 events per window.

## Validation

- e2e `monitoring` **5/5**: summary counts + recent events; replay window +
  ascending order; bad-window 400; RBAC 403; tenant isolation (another tenant
  sees zero). Full backend suite **56 suites / 412 tests**, zero regressions.
- Web `tsc`/`lint`/`build` green; smoke `/monitoring`→307 login.

## Files

- Backend: `apps/api/src/modules/monitoring/` (service, controller, module),
  `packages/contracts/src/monitoring.ts`, `monitoring:read` in the RBAC catalog.
- Web: `apps/web/src/app/monitoring/` (`page.tsx`, `monitoring-wall.tsx`,
  `replay-panel.tsx`, `actions.ts`); "Command Center" sidebar entry + middleware.

## Follow-ons

- WS-push (P2.3 WS-ticket) for instant tiles + ticker.
- ClickHouse-backed counts / trends for very large tenants.
- Map snapshot tile (reuse §3.4 GIS), multi-monitor layout presets.
- Replay overlay on the map / incident timeline visualisation.
