# ADR-0035: Realtime WebSocket gateway

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.3
**Depends on:** ADR-0031 (event plane / NATS), ADR-0019 (RBAC, P1.1)

## Context

The platform needs a realtime plane: push domain events (incident created /
transitioned / assigned, …) to browsers as they happen, instead of polling.
P2.1 built the event backbone (outbox → relay → NATS JetStream); P2.3 delivers
the browser-facing edge.

## Decision

A WebSocket gateway that authenticates a connection, lets it subscribe to event
subjects (tenant- and RBAC-scoped), and pushes matching events to it live.

### In `apps/api`, not a separate `apps/realtime` app

The plan sketched a standalone app. We built the gateway **inside `apps/api`**:
it reuses the global `JwtService`, the P1.1 `RbacService`, the NATS connection,
config, and the test harness — realtime works in days, not weeks, and a separate
app would have to re-solve all of that (RBAC especially lives in `apps/api`). The
gateway is a self-contained module, so it can be extracted to its own app when WS
connection load justifies isolating it from request serving.

### Native `ws` on the HTTP `upgrade` event (no Nest WS adapter)

Uses a `noServer` `ws` server attached to the existing HTTP server's `upgrade`
event (via `HttpAdapterHost`) rather than `@nestjs/websockets` + a Nest WS
adapter. A Nest adapter is process-global and would touch every test suite; the
upgrade-hook approach is isolated (claims only `/v1/realtime`), gives full
control of the handshake (needed to authenticate **before** accepting), and is
gated cleanly by `REALTIME_ENABLED` (off → no hook, the endpoint isn't there).
Native `ws` means the browser uses the standard `WebSocket` API — no client lib.

### Auth before the handshake

`WsAuthService` authenticates **during** the upgrade, before the `101`: verify
the access JWT (HS256 + issuer pinned, exactly like `TenantContextMiddleware`)
and confirm the session is still active in the DB. Failure → a plain `401` and
the socket is destroyed (no `101`, no data, nothing registered). The token is
presented via the **`cmc-bearer` subprotocol** (preferred — never lands in a
URL/log) or an `?access_token=` query param (curl/fallback).

### Tenant-isolated + per-subscription RBAC subscriptions

Subjects mirror the event plane: `tenant.<id>.<aggregate>.<event>.v<n>`. A
subscription is accepted only when it (1) is literally scoped to the connection's
own tenant (`tenant.<ownId>.…` — cross-tenant, `tenant.*`, and `system` are
rejected), (2) names an aggregate type the user is authorised to read —
**fail-closed** via a `subject → permission` map (`incident → incident:read`;
unmapped or wildcard-aggregate → rejected), checked against the permissions
**resolved once at connect** (`RbacService.resolvePermissions`, which opens its
own tenant tx on cache-miss), and (3) is within a per-connection cap
(`REALTIME_MAX_SUBSCRIPTIONS`). A NATS-style matcher (`*`, `>`) decides delivery.

### NATS → WS fan-out: ephemeral consumer, `DeliverPolicy.New`

`RealtimeFanoutSubscriber` is an **ephemeral** JetStream consumer (per process)
filtering `tenant.>`; each event is `broadcast()` to the sockets whose
subscriptions match. Ephemeral (not a shared durable like the work-queue
consumers) because realtime is **fan-out** — every instance must see every event;
a shared durable would load-balance and starve half the sockets. `DeliverPolicy.New`
because a fresh browser wants live events, not stream history. Delivery is
best-effort (always ack — a realtime event is never redelivered to a browser).

## Consequences

**Positive**
- Live events to the browser over the whole proven chain: producer → outbox →
  relay → NATS → fan-out → WS. Verified live: `POST /v1/incidents` → a subscribed
  socket received `tenant.<id>.incident.created.v1`.
- Reuses JWT + RBAC + NATS; small net-new surface; zero blast radius on the
  suite (no global adapter); `ws`/`nats` never break jest (`nats` dynamic-imported,
  realtime suite drives real sockets).
- Defence in depth: auth-before-handshake, tenant isolation, fail-closed RBAC.

**Negative / deferred**
- **Single-instance fan-out.** Multi-instance correctness needs cross-instance
  fan-out (**Redis pub/sub**) — forward-looking; ephemeral consumers keep each
  instance correct in isolation today.
- **RBAC resolved at connect** — a mid-connection revocation isn't enforced until
  reconnect (bounded by session/JWT TTL).
- **No web client yet** — the browser-side hook/UI that consumes this is a
  follow-on (pairs naturally with the P2.6 dashboard).
- In-memory registry — connection state is per-process (lost on restart; clients
  reconnect).

## Validation

- **Suite**: 237/237, 30 suites. `realtime` (14): pure subject matcher +
  tenant-scope + `requiredPermissionForSubject` (fail-closed); live sockets —
  authenticated connect (subprotocol + query), unauth/garbage-token rejection,
  tenant-scoped subscribe accept/reject, **RBAC rejection** (role-less user),
  broadcast delivery + non-match/cross-tenant isolation, unsubscribe, ping/pong,
  status endpoint.
- **Live smoke** (booted API, real WS, NATS on): subprotocol auth → welcome →
  own-tenant subscribe accepted / wildcard rejected; `POST /v1/incidents` →
  socket received `incident.created.v1` end-to-end.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration
  (in-memory registry).
