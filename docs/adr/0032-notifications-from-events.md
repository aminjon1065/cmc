# ADR-0032: Event-driven notifications (first event consumer)

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P2.4
**Depends on:** ADR-0031 (event plane), ADR-0024 (notifications), ADR-0023 (incidents)

## Context

P1.6 dispatched incident notifications by a **direct in-process call** from
`IncidentsService` to `NotificationsService`. That couples the two modules and
won't scale to cross-process / multi-consumer reactions. P2.1 built the event
plane (outbox → relay → NATS). P2.4 makes notifications the **first durable
consumer**, proving the consume-side and decoupling the trigger from the effect.

## Decision

A durable JetStream consumer reacts to incident events and dispatches the
notifications; the inline dispatch is kept only as a fallback when the event
plane is off — so there's **zero regression** and never a double-fire.

### Handler vs subscription (testable seam)

`IncidentNotificationsConsumer.handle(envelope)` is the pure unit of work: it
filters to `incident.assigned` / `incident.transitioned`, **claims** the event
in the dedup ledger, loads the incident (tenant-scoped), and calls
`NotificationsService` with an actor reconstructed from `payload.by`. Tests call
`handle()` directly — no NATS. `IncidentNotificationsSubscriber` is the thin
NATS plumbing (durable consumer → `handle` → ack/nak), dynamic-importing `nats`
only when `NATS_ENABLED`, so the package never enters jest.

### Idempotency — a reusable dedup ledger

The bus is at-least-once, so `handle()` first `claim(eventId, "incident-
notifications")` against `consumed_events (event_id, consumer)`; a redelivery
conflicts and is skipped. Keyed by consumer name so every future consumer
(P2.2, …) dedups independently. (Proven: re-running `handle` on the same event
creates no second notification.)

### `DeliverPolicy.New`, not `All`

A freshly-created notifications consumer must **not** replay the whole stream and
re-notify historical events. `DeliverPolicy.New` delivers only events published
after the consumer was created; the dedup ledger covers redelivery for the
running consumer. (A projection consumer like P2.2 will instead use `All` — it
*wants* history.)

### Zero-regression fallback

`IncidentsService` now dispatches inline **only when `NATS_ENABLED` is false**.
With NATS on (production), the consumer is the sole path (decoupled); with NATS
off (default dev/test), the inline path is unchanged — so the P1.6 notification
tests stay green and dev without NATS still notifies. Exactly one path fires.

### Module wiring

A leaf `IncidentNotificationsModule` imports `IncidentsModule` +
`NotificationsModule` (neither imports it → no cycle) and uses the global
`EventsModule`'s `EventDedupService`. `IncidentsService.getDetailForTenant()`
loads an incident from outside a request (the consumer has no ambient tx).

## Consequences

**Positive**
- First durable consumer — proves the event plane's consume-side end-to-end
  (verified live: HTTP assign with NATS on → event → relay → JetStream →
  consumer → notification, inline skipped).
- Incidents ↔ notifications decoupled on the production path.
- Idempotent (dedup ledger) + forward-only (DeliverPolicy.New) — no duplicate /
  no historical re-notification.
- Zero regression: existing P1.6 behaviour + tests intact via the NATS-off
  fallback.
- The consumer/dedup/subscriber pattern is the template for P2.2 / future
  consumers.

**Negative / deferred**
- **Two dispatch paths** during the transition (event vs inline). Acceptable —
  exactly one fires per config; the inline path retires when NATS is mandatory.
- **No dead-letter** yet — a permanently-failing event `nak`s forever; a max-
  deliver + DLQ is a later hardening.
- **Outbox/consumed_events pruning** still deferred.
- Single-instance consumer; horizontal scale (queue group / multiple workers)
  is forward-looking.

## Validation

- **Suite**: 216/216, 27 suites. `incident-notifications` (4): `handle(assigned)`
  notifies + idempotent; `handle(transitioned)` notifies reporter+assignee minus
  actor; ignores unhandled events (no claim, no dispatch); inline still fires
  when NATS off. Existing P1.6 notification tests unchanged + green.
- **Live smoke** (NATS on): real `POST /v1/incidents/:id/assign` → inline
  **skipped** → outbox → relay → durable consumer → assignee received exactly one
  `incident.assigned` notification; `DeliverPolicy.New` confirmed (no history
  replay after a clean stream).
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean.
