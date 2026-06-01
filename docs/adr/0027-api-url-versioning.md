# ADR-0027: API URL versioning (`/v1`)

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.9
**Depends on:** — (touches every controller transparently via a global prefix)
**Relates to:** ADR-0014 (Prometheus RED), ADR-0015 (health probes), ADR-0016 (Caddy edge), ADR-0025/0026 (obs stack)

## Context

Every API route was served at its bare path (`/auth/login`, `/incidents`, …).
The platform has exactly one consumer today — the Next.js BFF — but ToR §11.6
requires URL versioning, and the cost of introducing it rises sharply once
external consumers (mobile, partner integrations, tenant-operated tooling) pin
to unversioned paths. Introducing `/v1` **now**, while the only caller is in
the same monorepo, is a one-commit change; doing it later is a breaking
migration coordinated across clients we don't control.

A second motivation surfaced during P0.9 (ADR-0016): the API's bare paths
**collide** with web routes (`/documents` is both an API resource and a web
page), which forced subdomain-based proxy routing. Versioning the API under
`/v1` removes that collision and unblocks path-based routing as a future
option.

## Decision

**Apply a single global prefix `v1` to all domain routes; exclude operational
endpoints.**

```ts
// apps/api/src/main.ts
app.setGlobalPrefix("v1", {
  exclude: [
    { path: "health",        method: RequestMethod.GET },
    { path: "health/ready",  method: RequestMethod.GET },
    { path: "health/deep",   method: RequestMethod.GET },
    { path: "metrics",       method: RequestMethod.GET },
  ],
});
```

### Why a global prefix, not NestJS URI versioning

NestJS offers `app.enableVersioning({ type: VersioningType.URI })` with
per-controller `@Version()` decorators. We rejected it for now: we have exactly
**one** version and no controller needs to straddle two. A global prefix is
zero-decorator, impossible to forget on a new controller, and trivially
visible in one place. When a genuine `v2` arrives (some endpoints change shape,
others don't), we migrate to `enableVersioning` with `defaultVersion: '1'` —
the URL shape (`/v1/...`) is identical, so it's a non-breaking internal swap.

### Why `/health*` and `/metrics` are NOT versioned

These are **operational** endpoints consumed by infrastructure, not API
clients, and their paths are hardcoded in places we'd silently break:

- **`/metrics`** — the Prometheus scrape config (`metrics_path: /metrics`,
  ADR-0014, P1.7/P1.8 obs stack) pulls this. Moving it to `/v1/metrics` would
  blank every RED/USE panel and every alert rule.
- **`/health`, `/health/ready`, `/health/deep`** — orchestrator
  liveness/readiness probes (ADR-0015) and the Caddy ops-endpoint block
  (ADR-0016) reference these literally.

Versioning is a **client-API contract** concern; ops endpoints are outside that
contract, so they keep stable, unversioned paths. The RED middleware's
exclusion check reads `req.originalUrl` (which stays `/metrics` / `/health` for
the excluded routes), so metric exclusion keeps working unchanged.

### Route label carries the prefix

NestJS registers routes prefix-inclusive on the Express adapter, so
`req.route.path` — the source of the RED histogram's `route` label — becomes
`/v1/auth/login`. This is correct and desirable: the metric label matches the
real URL. The one e2e assertion that pinned the old label was updated.

## Web client

`apiFetch` (`apps/web/src/lib/api.ts`) is the single chokepoint for every
server component, server action, `access.ts`, and `branding.ts` call. A lone
`const API_PREFIX = "/v1"` there versions all of them:

```ts
const url = `${API_BASE_URL}${API_PREFIX}${normalizedPath}`;
```

NextAuth (`auth.ts`) is the one caller that bypasses `apiFetch` — it POSTs
directly to `/auth/login`, `/auth/refresh`, `/auth/logout` from the credentials
provider and refresh callback. It carries its own `API_V1` constant kept in
lockstep. The web app **never** calls `/health` or `/metrics`, so the prefix is
applied unconditionally — no exclusion logic needed on the client.

## Tests

The global prefix is mirrored in `buildTestApp` so the e2e suite exercises the
**real** prefixed routing (a prefix misconfiguration fails a test, not just
production). All 293 domain request paths across 17 spec files + the
`loginAs`/`refresh` helpers were rewritten to `/v1/...` with a single anchored
substitution that left `/health` and `/metrics` calls untouched. One assertion
(metrics RED route label) was updated by hand.

## Consequences

**Positive**
- ToR §11.6 satisfied; the contract is locked under `/v1` before any external
  consumer exists.
- Live-verified: old unversioned domain paths now return **404** — there is no
  silent dual-serving, so nothing can accidentally depend on the old shape.
- Obs stack + health probes untouched (paths excluded); zero operational
  regression.
- Unblocks path-based reverse-proxy routing (the `/documents` collision from
  ADR-0016 is gone under `/v1/documents`).

**Negative / deferred**
- A real `v2` will require migrating to `enableVersioning` (non-breaking URL
  shape) — deferred until a second version actually exists.
- **Sunset headers** (ToR §11.6) and deprecation policy are not implemented;
  there's nothing to deprecate yet. Deferred.
- OpenAPI generation (P1.10) will serve under `/v1/openapi.json`.

## Validation

- **Suite**: 164/164, 19 suites green (test app runs the real `/v1` routing).
- **Live smoke** (dev DB, API on :3009):
  - `POST /v1/auth/login` → **200** + JWT; old `POST /auth/login` → **404**.
  - `GET /v1/rbac/me` no-auth → **401** (routed, guard rejects); `/rbac/me` → **404**.
  - `GET /health`, `/health/ready`, `/metrics` → **200**; `/v1/health`, `/v1/metrics` → **404**.
  - Authed `GET /v1/rbac/me` with bearer → **200**.
  - `/metrics` shows `http_request_duration_seconds_count{...route="/v1/auth/login"...}`.
- **Build/lint**: API `tsc --noEmit` clean; web `next build` + `next lint` clean.
