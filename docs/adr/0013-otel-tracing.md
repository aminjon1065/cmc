# ADR-0013: OpenTelemetry tracing (HTTP + DB + S3)

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.6
**Closes tech-debt:** TD-008 (trace_id half — request_id was closed by P0.3)
**Depends on:** ADR-0010 (structured logs + request_id / ALS)
**Unblocks:** P0.7 (Prometheus metrics), P1.8 (Tempo + Alertmanager)

## Context

P0.3 (ADR-0010) gave every log line and audit row a `request_id` via an
AsyncLocalStorage (ALS) context, and explicitly **reserved** the
`trace_id` slot for "once OTEL lands." The `audit_log.trace_id` column
has existed since the initial schema but was always written `NULL`.

Without distributed tracing, debugging anything that crosses a boundary
(HTTP → DB → S3, or — soon — HTTP → NATS → consumer) means grepping logs
by `request_id` and reconstructing causality by hand. ToR §14.2 lists
tracing as a baseline observability pillar, and the audit calls for it as
the highest-leverage gap after structured logging.

P0.6 lands the tracing substrate: the app **emits** spans for HTTP, the
database, and S3, and `trace_id` flows into both logs and audit rows. The
collector that *receives* those spans (Tempo) is a separate concern,
deferred to P1.8 — this ADR makes "P0.6 already emits" true.

## Decision

### 1. `@opentelemetry/sdk-node` + auto-instrumentations, started first

`apps/api/src/tracing.ts` constructs a `NodeSDK` with
`getNodeAutoInstrumentations()` and starts it as an **import side-effect**.
It is the very first import in `main.ts` (and the first jest `setupFile`
in tests) because the instrumentations monkey-patch `http`, `express`,
`@nestjs/core`, `@aws-sdk/*`, and `ioredis` at require time — they must
run before any of those modules load.

Compiled output proves the ordering: `dist/main.js` begins with
`require("./tracing")`.

Instrumentations explicitly disabled: `fs` (extremely noisy), `net`,
`dns` (little signal over the HTTP + DB spans). Everything else in the
bundle stays on, which includes a freebie: the **ioredis**
instrumentation (rate-limit / session-cache Redis calls) — confirmed
active in the emit check (it produced a redis `connect` span).

**Dependency gotcha (load-bearing for the build).** Adding
`@opentelemetry/api` to `apps/api` caused pnpm to resolve a *second*
peer-variant of `drizzle-orm`
(`drizzle-orm@0.38.4_@opentelemetry+api…_@types+pg…`) distinct from the
one `packages/db` resolved. Drizzle's `SQL<unknown>` carries a private
field, so two physical copies are nominally incompatible → ~96
`tsc` errors ("separate declarations of a private property
'shouldInlineParams'") even though the runtime is identical. Fix:
declare `@opentelemetry/api` + `@types/pg` in `packages/db`
devDependencies so both workspaces resolve the **same** drizzle variant.
Invariant to preserve: any future package that pulls in an OTEL or
`pg`-typed dependency alongside Drizzle must keep `packages/db` and
`apps/api` on a single drizzle peer-variant (check with
`ls -l */node_modules/drizzle-orm`).

### 2. Exporter is gated on configuration; span creation is not

| Condition | Behaviour |
|---|---|
| `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` set | OTLP/HTTP exporter, `BatchSpanProcessor` (this is what P1.8 sets) |
| `OTEL_TRACES_CONSOLE=true` | `ConsoleSpanExporter`, `SimpleSpanProcessor` (dev/debug) |
| neither | no span processor; `OTEL_TRACES_EXPORTER=none` set so NodeSDK does **not** fall back to its default `localhost:4318` exporter |
| `OTEL_ENABLED=false` | SDK never starts — no spans at all (kill switch) |

The load-bearing property: **spans are created and context propagates
regardless of whether anything is exported.** So in the default dev/CI
posture (no collector) `trace_id` still flows into logs + audit and W3C
`traceparent` is still honoured — with zero connection-refused noise.
This is what lets P0.6 ship the value before P1.8 stands up Tempo.

Sampling (`OTEL_TRACES_SAMPLER` / `_ARG`), headers, and other OTEL knobs
are honoured by NodeSDK's own env parsing — no code change to tune them.

### 2a. No-collector posture uses a no-op span processor, NOT `OTEL_TRACES_EXPORTER=none`

A subtle sdk-node behaviour cost a debugging cycle and is worth pinning:
setting `process.env.OTEL_TRACES_EXPORTER = "none"` does **not** mean
"initialise the SDK but export nothing" — in `@opentelemetry/sdk-node`
0.218 the literal `"none"` makes `NodeSDK.start()` **skip initialisation
entirely** (no instrumentations, no spans). That silently defeats the
whole "trace_id still flows with no collector" goal.

The correct way to get "fully initialised, exports nothing, no
localhost:4318 fallback" is to pass an explicit, non-empty
`spanProcessors` array containing a **no-op processor** (all four
lifecycle methods are no-ops). NodeSDK then never consults
`OTEL_TRACES_EXPORTER` and never installs the default exporter.
`buildSpanProcessors()` therefore always returns a non-empty array:
OTLP exporter, console exporter, or the no-op.

### 2b. A fallback SERVER span is created when auto-instrumentation didn't

The HTTP auto-instrumentation patches `http` via `require-in-the-middle`.
That works in production (`node dist/main.js`) but **not under jest**,
which loads modules through its own runtime so the patch never fires and
no server span exists. Rather than let trace_id silently vanish in that
case, `RequestContextMiddleware`:

1. reads `trace.getActiveSpan()`; if present (production), uses it;
2. otherwise extracts the inbound W3C context
   (`propagation.extract(ROOT_CONTEXT, req.headers)`) and starts its own
   `SpanKind.SERVER` span via a `cmc-http` tracer, ending it once on
   `finish`/`close` (guarded against double-end).

This uses only the OTEL **API** (`context` / `propagation` / `trace`),
which `sdk.start()` wires up independently of module patching — so it
works whether or not auto-instrumentation succeeded. Net effect:
`X-Trace-Id` and an honoured inbound `traceparent` are guaranteed in
every environment, and the e2e suite can assert the behaviour
deterministically. In production this branch is rarely taken (the auto
HTTP span already exists), but it also makes the system robust if the
HTTP instrumentation is ever disabled.

### 3. trace_id reaches logs + audit via the existing ALS, not the OTEL API

The existing P0.3 plumbing already carries `request_id` through
`RequestContextService` (ALS). P0.6 reuses that seam rather than coupling
the logger and audit writer to `@opentelemetry/api`:

- `RequestContext` gains an optional `traceId`; the service gains
  `getTraceId()` / `setTraceId()`.
- `RequestContextMiddleware` reads the active span
  (`trace.getActiveSpan()`), validates the span context, stamps
  `traceId` into the ALS, and echoes it as an **`X-Trace-Id`** response
  header. It is the *only* file (besides `tracing.ts` and the DB service)
  that imports the OTEL API.
- `pino` `customProps` adds `traceId` to every log line (alongside the
  existing `requestId`).
- `AuditService.toRow()` defaults `trace_id` from
  `requestContext.getTraceId()` — the same `?? ALS ?? null` pattern as
  `request_id`, so every audit row auto-joins to its trace, including the
  durable-failure path (the privileged tx that survives a 401 throw still
  sees the ALS value).

`X-Trace-Id` is the operator's pivot handle — paste it into Tempo /
Grafana — and the deterministic assertion handle for the tests.

### 4. Database spans are emitted manually at the GUC chokepoints

postgres-js (porsager `postgres`) — the driver this codebase uses — has
**no** OpenTelemetry auto-instrumentation (the bundle's `pg`
instrumentation is for node-postgres, a different package). Rather than
ship "Postgres tracing" that silently captures nothing, P0.6 emits a
**transaction-level** span at the two chokepoints in
`TenantDatabaseService`:

- `runForTenant()` → `db.tx tenant`
- `runPrivileged()` → `db.tx privileged`

Each carries `db.system=postgresql` and `cmc.db.scope`, nests under the
active HTTP span (via `startActiveSpan`), and records exceptions / sets
`ERROR` status on failure. With tracing disabled it is a no-op tracer —
the callback runs directly, zero overhead.

This gives every request a DB segment in its trace. **Statement-level**
spans (one per SQL query) are deliberately out of scope — they await
either a postgres-js OTEL instrumentation or a migration to `pg`. The
transaction span is the honest, cheap 80/20.

### 5. S3 via the aws-sdk auto-instrumentation

`@aws-sdk/client-s3` command sends (`HeadObject`, `DeleteObject`, …) are
captured by the bundle's `aws-sdk` instrumentation — no code change.
Pre-signed URL generation is local crypto (no network call) and
correctly produces no span.

### 6. Tests run with tracing ON, no exporter

`test/tracing-setup.ts` (a jest `setupFile`, ordered after `env.ts`)
imports the production `tracing.ts`, so the test process instruments
exactly like `main.ts`. `.env.test` sets `OTEL_ENABLED=true` with no
exporter. `tracing.e2e-spec.ts` asserts the seams: `X-Trace-Id` is a
32-hex on a normal request; an inbound W3C `traceparent` is adopted;
`audit_log.trace_id` matches the response trace id on both the success
and durable-failure login paths; and `request_id` (UUID) and `trace_id`
(32-hex) coexist as distinct ids.

Under jest the http auto-instrumentation does **not** patch `http` (jest's
module runtime bypasses require-in-the-middle), so the fallback SERVER
span in §2b is what carries trace_id during the suite — verified
empirically (62/62 green), and a faithful exercise of the same code path
that runs in production when no auto span is present.

## Consequences

**Positive:**

- TD-008 fully retired — `trace_id` now populated in logs and audit;
  joins audit rows to traces and (once P1.8 lands) to the Tempo waterfall.
- The app emits HTTP + DB + S3 + Redis spans today; turning on the
  collector at P1.8 is a single env var (`OTEL_EXPORTER_OTLP_ENDPOINT`),
  no code change.
- Default posture is safe and quiet: no collector → no errors, but full
  trace_id correlation and W3C propagation still work.
- P0.7 (Prometheus) is unblocked — the OTEL SDK is the natural home for a
  metrics pipeline too.

**Negative / known gaps:**

- **No statement-level DB spans.** postgres-js isn't auto-instrumentable;
  only transaction-level `db.tx` spans exist. A slow individual query
  won't show as its own span until a postgres-js instrumentation exists
  or we move to `pg`.
- **No collector yet.** Spans are created but not stored anywhere by
  default; the Tempo container + retention is P1.8. Until then, the
  `OTEL_TRACES_CONSOLE=true` toggle is the only way to *see* spans.
- **No metrics / no logs-export via OTEL.** P0.6 is traces only. Metrics
  → P0.7; log shipping (Loki) → P1.7.
- **Sampling is AlwaysOn by default.** Fine at current volume; a ratio
  sampler should be set via `OTEL_TRACES_SAMPLER` before high traffic to
  control collector cost. No code change needed when that time comes.
- **trace_id is not yet in the problem+json error body.** It is in the
  `X-Trace-Id` header; the body still carries only `request_id`. Cheap
  follow-on if support workflows want it in the body.

## Triggers for re-evaluation

- A second service appears (WS gateway, worker) → extract `tracing.ts`
  into a shared `@cmc/otel` package so every process instruments
  identically, and confirm W3C context propagates across the NATS hop
  (P2.1) via message headers.
- DB query hotspots need per-statement visibility → add a postgres-js
  instrumentation (or migrate to `pg`) for statement spans.
- Collector cost climbs → set `OTEL_TRACES_SAMPLER=parentbased_traceidratio`
  with an `_ARG` below 1.0.
- Trace volume reveals PII in span attributes → add a span processor that
  scrubs attributes before export (the audit redaction list is the model).

## References

- [PRIORITY_EXECUTION_PLAN P0.6](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-008](../audit/TECH_DEBT_REGISTER.md)
- [ADR-0010](./0010-structured-logging-request-id.md) — the ALS + request_id seam this extends
- [OBSERVABILITY_REVIEW](../audit/OBSERVABILITY_REVIEW.md)
- ToR §14.2 (tracing), §13.11 (OTEL)
