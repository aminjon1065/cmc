# ADR-0010: Structured logging + request_id propagation

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.3
**Closes tech-debt:** TD-007 (unstructured logs), TD-008 (no request_id / trace_id populated)

## Context

The codebase shipped with 13 `Logger` call sites scattered across services,
all writing text lines to stdout via NestJS's default logger. The
`audit_log.request_id` and `audit_log.trace_id` columns existed since
[migration 0000](../../packages/db/migrations/0000_initial.sql) but nothing
populated them.

That left three concrete problems:

1. **Incident investigation requires manual grep across processes.** Two
   log lines emitted milliseconds apart by different services cannot be
   tied to the same request without timestamp-eyeballing.
2. **Loki / OpenSearch ingestion is regex-based** (slow, brittle) instead
   of native JSON.
3. **No PII redaction** — a careless `Logger.log(user)` dumps email + ID.

The ToR addresses all three in §13.10 (structured JSON), §13.11 (trace
correlation), §20.1 principle 7 ("untraced is unfinished"). [P0.3 in the
priority plan](../audit/PRIORITY_EXECUTION_PLAN.md) is the agreed
landing point for the substrate; trace correlation specifically lands
later at P0.6 (OTEL).

## Decision

### 1. Logger library: `nestjs-pino`

Canonical NestJS wrapper around `pino` + `pino-http`. Picked for:

- **Zero touch** at call sites — every existing `new Logger("Foo")`
  pipes through pino transparently. No service-by-service rewrite.
- **AsyncLocalStorage-aware** request scoping via the upstream
  `pino-http` middleware; meshes cleanly with our existing ALS-backed
  contexts.
- **Fast** — pino is the fastest Node logger, ~µs per line.
- **Mature** redact / serializer / mixin hooks.

Rejected:
- `winston` — slower, ToR doesn't prescribe it.
- Hand-rolled JSON shim around `pino-http` — would reinvent the
  NestJS-flavoured wiring nestjs-pino already provides.

### 2. New ALS service: `RequestContextService`

Separate from `TenantContextService` because:

- `request_id` exists for *every* request, including anonymous and
  failed-auth ones. The durable-audit path on login failure / rate-limit
  denial needs it.
- `request_id` is transport-level (correlates log lines, audit rows,
  traces); `tenant_id` is security-level (who is this). Conflating
  them invites future bugs.

The service holds `{ requestId: string, correlationId?: string }`. The
`correlationId` slot is reserved for the future case where an upstream
integration partner sends an `X-Correlation-Id` we want to thread
through audit + logs without conflating with our per-hop `request_id`.

### 3. Middleware: `RequestContextMiddleware`

Runs **first** — before `TenantContextMiddleware`. Responsibilities:

1. Read inbound `X-Request-Id`. If present **and** UUID-shaped, honor.
   Otherwise mint a fresh UUID v4.
2. Stash on `req.requestId` for direct Express access (used by the
   exception filter to avoid DI).
3. Set `X-Request-Id` on the response immediately (so even responses
   produced by middleware or guards downstream still carry it).
4. Open an `AsyncLocalStorage.run({ requestId }, next)` scope so every
   downstream service can read the id without parameter threading.

**Security note on the UUID-shape gate:** without it, an attacker could
inject arbitrary strings (`<script>`, SQL fragments, log-format
sequences) into the `audit_log.request_id` column and into stdout. The
UUID regex closes that door cheaply.

### 4. Pino options

Centralised in `apps/api/src/common/logging/pino-options.ts`. Highlights:

- **`level`** — read from `LOG_LEVEL` env (already validated by zod).
- **`genReqId`** — returns `req.requestId` set by the middleware so
  pino-http's request-completed log line carries the same id audit
  rows use.
- **`customProps` mixin** — reads `RequestContextService` and
  `TenantContextService` at log time. Every line therefore carries
  `requestId`, optionally `tenantId`, `tenantSlug`, `userId`. Anonymous
  requests omit the tenant fields naturally.
- **`autoLogging.ignore`** — suppress request-completed logs for
  `/health` and `/health/ready`. These are noise; legitimate failures
  still surface via the error path.
- **`serializers.req`** — minimal header allowlist (`user-agent`,
  `x-forwarded-for`, `x-request-id`, `content-type`, `content-length`).
  Default pino-http would log *every* header — that leaks `Authorization`,
  `Cookie`, `X-Api-Key` into stdout.
- **`redact`** — paths: `req.headers.authorization`,
  `req.headers.cookie`, `req.headers["x-api-key"]`,
  `req.body.password`, `req.body.refreshToken`, plus defensive
  domain-side paths (`password`, `passwordHash`, `refreshToken`,
  `*.password` etc.) in case some future code logs a full DB row.
- **`transport`** — `pino-pretty` in non-production for readable local
  output; raw JSON in production for log aggregator ingestion.

### 5. Email is NOT redacted

Email is the primary debug pivot for audit / login investigations,
already lives in `audit_log.metadata` for failed logins, and is part of
the audit contract. Listing it as a redact path would force investigators
to cross-reference via user-id only — a step backwards.

### 6. AuditService auto-populates `request_id`

`AuditService.toRow()` now defaults `request_id` from
`RequestContextService.getRequestId()` if the caller did not specify it.
This means:

- Every existing `audit.record({...})` call site gets correlation for
  free.
- Future code that touches AuditService cannot accidentally write
  `request_id: NULL` — the default flows from ALS.
- A caller can still override (e.g. when replaying historical events
  from an outbox).

### 7. HttpExceptionFilter surfaces `request_id` in problem+json body

`request_id` is now a top-level field on every error response (rate-limit
429, RFC-7807 4xx/5xx alike). Two reasons:

- Some HTTP clients hide response headers in their error UIs; the body
  is the universally accessible surface.
- On-call rotations want a single string they can paste into log search
  — having it in the visible response body shortens "user reports
  error" → "log entry found" by minutes.

The header `X-Request-Id` continues to be set on every response (set
once by the middleware; the filter doesn't have to set it again).

### 8. CORS exposes `X-Request-Id`

`apps/api/src/main.ts` adds `exposedHeaders: ["X-Request-Id"]` to the
CORS config so the web app can read it from `fetch()` responses (CORS
otherwise hides non-allowlist response headers from browser JS).

### 9. Bootstrap log buffering

`NestFactory.create(AppModule, { bufferLogs: true })` queues Nest's own
bootstrap logs until `app.useLogger(app.get(PinoLogger))` runs, then
replays them through pino. Without this, the very first log lines of
each process would land in the default Nest text format while everything
after them is JSON — a small but real Loki-side parsing headache.

## Consequences

**Positive:**

- TD-007 + TD-008 retired in one change.
- Every audit row from now on is correlatable to a log line, an HTTP
  response, and (post-P0.6) a trace.
- Loki / OpenSearch ingestion lands on JSON instead of regex parsing.
- Sensitive fields are structurally absent from logs — not a "do not
  log this" convention, an actual redact list enforced by pino.
- Existing call sites (13 `new Logger(...)` instances) need zero
  changes.

**Negative / known gaps:**

- **No tracing yet.** `trace_id` still NULL in the audit table; the
  pino mixin reserves the slot for P0.6 OTEL to populate.
- **No log shipping yet.** Loki + Promtail land at P1.7. Until then
  logs go to stdout only.
- **No log rotation in compose.** Docker handles size capping by
  default; documented as a P0.9 (deploy) concern.
- **Email is visible in logs.** Documented decision; not a redact gap.
- **`req.body` redact has known gaps under polymorphic shapes.** pino
  redact paths are exact-match; if a future endpoint accepts password
  fields under a different name (e.g. `newPassword`), it must be
  added to the redact list. A code-review check is the only
  enforcement today.

## Triggers for re-evaluation

- Log shipping infrastructure (Loki) lands → revisit retention,
  sampling, structured-error vs unstructured-error policies.
- OTEL trace context lands at P0.6 → wire `trace_id` into pino mixin
  + `AuditService.toRow()`.
- First time a user-impacting bug is debugged via log grep instead of
  request_id → check whether the relevant log line carries the
  expected ALS context.
- First false-positive on PII redaction (e.g. a domain field gets
  redacted by `*.password` glob and shouldn't be) → tighten the
  pattern.

## References

- [PRIORITY_EXECUTION_PLAN.md P0.3](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER.md TD-007 / TD-008](../audit/TECH_DEBT_REGISTER.md)
- [OBSERVABILITY_REVIEW.md §2](../audit/OBSERVABILITY_REVIEW.md)
- [ADR-0008](./0008-redis-tier-1-dependency.md)
- [ADR-0009](./0009-auth-rate-limiting.md)
