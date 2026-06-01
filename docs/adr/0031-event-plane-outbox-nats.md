# ADR-0031: Event plane — transactional outbox + NATS JetStream relay

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P2.1 (a + b + c)
**Depends on:** ADR-0011 (tenant tx / ALS), ADR-0013 (trace context), ADR-0023 (incidents)
**Unblocks:** P2.2 (ClickHouse projection), P2.3 (WebSocket), P2.4 (event-driven notifications)

## Context

P2 needs an **event plane**: domain modules emit events, other modules react,
without point-to-point coupling. The hard requirement is **no dual-write** — an
event must be exactly as durable as the state-change it describes. A naive
"write the row, then publish to NATS" loses events when the process dies between
the two, or emits phantom events when the publish succeeds but the tx rolls back.

## Decision

The **transactional outbox** pattern + a polling relay to **NATS JetStream**.

### Write side — the outbox (P2.1a)

`OutboxService.publish()` appends an event row to the `outbox` table. The key:
it inserts via the **ambient request transaction** (read from the ALS slot, the
same tx the global tenant-tx interceptor opened and that `.run()` reuses), so
the event and the state-change commit or roll back **together**. No dual-write.
With no ambient tx (background jobs / system events) it opens its own privileged
tx. The shared **`EventEnvelope`** contract (`@cmc/contracts`) is the wire
format — one outbox row ⇄ one envelope ⇄ one NATS message; the row `id` is the
dedup key end-to-end. `traceId` threads from the request context, so a consumer
can correlate an event back to the request that produced it.

The `outbox` table mirrors `audit_log`'s RLS (insert permissive; reads
tenant-scoped or privileged; UPDATE/DELETE privileged — the relay stamps
`published_at`). A `seq bigserial` gives the relay an exact, gap-free order.

### Relay — outbox → NATS (P2.1b)

A polling `RelayService` reads unpublished rows (`published_at IS NULL`) in `seq`
order, publishes each to its subject
**`tenant.{scope}.{aggregate}.{event}.v{version}`** via an `EventPublisher`, and
stamps `published_at` — all in one privileged tx. Publish-then-stamp means a
publish failure rolls the stamp back and the row re-ships:
**at-least-once**, and JetStream's `msgID` (= event id) dedups server-side, so
the stream sees each event once. A blocking advisory lock serialises relays;
`flush()` runs on an interval (gated by `NATS_ENABLED`), via an endpoint, or in
tests — and `publisher.active` guards against stamping rows that were never
actually delivered.

`EventPublisher` is the seam tests fake: the `nats` package is **dynamically
imported only when `NATS_ENABLED`**, so it never enters the jest runtime. The
real `NatsEventPublisher` connects, idempotently ensures a JetStream stream
`CMC_EVENTS` over `tenant.>`, and publishes with `msgID`.

### First producer — incidents (P2.1c)

`IncidentsService` emits `incident.created` / `incident.transitioned` /
`incident.assigned` to the outbox **in the same request tx** as the state
change. A natural fit for P2.4 (notifications consumed from events, replacing
today's direct dispatch).

### Why polling, not LISTEN/NOTIFY; why per-tenant subjects

Polling by `seq` is restart-safe, naturally batches, and reuses the durable
pattern already proven for the audit export — adequate for this scale.
Per-tenant subject scoping (`tenant.{id}.…`) lets a consumer subscribe to one
tenant (`tenant.{id}.>`), one aggregate across tenants (`tenant.*.incident.*`),
or everything, and keeps tenant isolation visible on the bus.

## Consequences

**Positive**
- No dual-write — events are as durable as the state-change (proven: a
  rolling-back tx leaves no event).
- At-least-once + JetStream dedup → effectively exactly-once on the stream.
- Trace correlation flows through the whole pipeline (verified live).
- The `nats` dependency is isolated to production (lazy import) — jest stays
  clean, the publisher is faked.
- Unblocks the entire P2 reactive surface (projection, WS, event-driven
  notifications).

**Negative / deferred**
- **Polling latency** — events publish within one relay interval; a manual
  `POST /v1/events/relay/flush` exists for forcing.
- **Relay holds a tx during NATS round-trips** per batch — fine at this scale; a
  publish-then-batch-stamp optimisation is a later refinement.
- **No consumers yet** — P2.2 (ClickHouse projection) / P2.4 (notifications) are
  the first durable JetStream consumers.
- **Outbox pruning** — published rows accumulate; a retention/prune job is
  deferred.
- Relay ops endpoints reuse `tenant:manage`; a platform-superadmin gate is later.

## Validation

- **Suite**: 212/212, 26 suites. `events-outbox` (5): atomic write, **rollback →
  no event**, no-ambient-tx fallback, system events + causation, subject builder.
  `events-relay` (6): publish + stamp, idempotent re-flush, incremental, seq
  order, status, gated endpoints (via fake publisher). `incidents-events` (4):
  created/transitioned/assigned → outbox with correct envelope; ordered stream.
- **Live smoke** (real NATS): relay published 2 seeded events → a node consumer
  received them on the right subjects; then a **real `POST /v1/incidents`** →
  the background relay (2 s interval) auto-published `incident.created` →
  consumer received it with full payload **and a threaded `traceId`**;
  `published_at` stamped.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean.
