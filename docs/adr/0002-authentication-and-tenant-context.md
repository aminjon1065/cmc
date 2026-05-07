# ADR-0002: Authentication and tenant context

**Status:** Accepted
**Date:** 2026-05-08
**Supersedes:** —

## Context

The skeleton from ADR-0001 has no notion of "who is calling." Before any
domain module can be built, we need:

1. A way to authenticate users and prove identity to the API.
2. A way to derive *tenant scope* from that identity — every business row
   the platform touches carries `tenant_id`, and the platform must reject
   cross-tenant access by construction (ToR §3.2, principle of structural
   tenant isolation).
3. An audit trail that records authentication outcomes from day one.

The constraints from ADR-0001 still apply: solo developer, no paid runtime
dependencies, Docker Compose deployment, full ToR scope as the long-term
target.

## Decision

### 1. Token format: stateless JWT, HS256, server-issued

The API issues a single signed access token on `POST /auth/login`:

- Algorithm: **HS256** with a 48-byte server secret (`JWT_SECRET`).
- Lifetime: **1 day** (`JWT_EXPIRES_IN`).
- Claims: `sub` (user id), `tid` (tenant id), `ts` (tenant slug),
  `email`, plus the standard `iss`, `iat`, `exp`.
- No refresh token, no server-side session table — yet.

**Why HS256, not RS256:** at this stage the API is the only token issuer
*and* the only verifier. Asymmetric signing pays off when there are
multiple verifiers (e.g., independent services) that should not share the
issuing key. We don't have that yet. RS256 + key rotation is added when
the first independent service is extracted.

**Why no refresh token yet:** stateless JWT with no revocation is
acceptable for the solo-dev MVP — token expiry is the worst-case window
for a stolen token (1 day), and the audit log captures every login. The
follow-up that adds a `sessions` table with refresh-token rotation and
server-side revocation is queued for the iteration after the first real
domain module.

**Why no SMS / passwords-only:** ToR §6.11 explicitly excludes SMS-based
MFA. WebAuthn / TOTP MFA is queued for a later auth iteration.

### 2. Tenant context: `AsyncLocalStorage` populated by middleware

`TenantContextService` wraps Node's `AsyncLocalStorage`. A request-scoped
middleware (`TenantContextMiddleware`) extracts the JWT from the
`Authorization: Bearer ...` header, verifies it, and runs the rest of the
handler chain inside `als.run({ userId, tenantId, tenantSlug, email }, …)`.

Downstream services (audit, future repositories with RLS, etc.) read the
ambient context via `tenantContext.requireCurrent()` instead of threading
parameters through every call. Background jobs / cron / event consumers
that have no request set context manually with `tenantContext.run(…)`.

The `JwtAuthGuard` is intentionally lightweight: it only checks that
`req.tenantContext` was set by the middleware. The guard does not
re-verify the JWT — verification stays in one place.

### 3. Web auth: Auth.js v5 with Credentials provider, JWT session strategy

Auth.js (`next-auth@5.0.0-beta.25`) handles the browser session:

- Credentials provider posts the user's email/password to the API's
  `/auth/login`.
- The API JWT is captured in the `authorize()` return value.
- Auth.js wraps it in its own *session* JWT (encrypted with `AUTH_SECRET`)
  and stores that in an HTTP-only cookie.
- Server components / Route Handlers use `auth()` to read the session and
  forward `Authorization: Bearer <api jwt>` to the API via `authedApiFetch`.

This indirection means the API JWT never reaches the browser's JS
context — Auth.js's encrypted cookie wraps it.

A Next.js edge middleware (`apps/web/src/middleware.ts`) gates `/dashboard`
and the rest of the protected app surface, redirecting anonymous visitors
to `/login?next=…`.

### 4. Audit on every login

Every `/auth/login` outcome — success and failure — appends to
`audit_log` via `AuditService.record(...)`. Failures carry a `metadata.reason`
distinguishing user-not-found, wrong password, ambiguous tenant, and
tenant-not-active. Successes carry the full IP / user-agent.

Audit writes are best-effort: a failed write is logged but does not abort
the request. Future iteration moves audit writes through the outbox table
so they're transactional with the originating action.

### 5. Password hashing: argon2id

Default parameters: memoryCost = 19 MiB, timeCost = 2, parallelism = 1.
Calibrated against the OWASP 2023 minimum recommendation. Constant-time
verification path includes a dummy verify on the no-user code path so login
timing doesn't leak account existence.

### 6. Build: workspace packages compile to CJS dist

`@cmc/contracts` and `@cmc/db` now ship `dist/` directories with CJS
output (NestJS is CJS) and `.d.ts`. NestJS's `nest build` resolves these
via the `main` / `types` fields. Turbo's `build` task ensures upstream
packages compile before consumers.

## Consequences

**Positive:**
- One coherent identity surface across web + api.
- Tenant scope is structural — domain services cannot accidentally serve
  cross-tenant data.
- Audit trail covers auth from day one.
- The auth UI (`/login`, `/dashboard`, sign-out) works end-to-end as a
  reference for any future auth-touching feature.

**Negative / known gaps (queued for follow-up auth iteration):**
- **No revocation.** A stolen JWT remains valid until expiry. Mitigated
  by 1-day lifetime; resolved when sessions table + refresh tokens land.
- **No MFA.** TOTP and WebAuthn are queued.
- **Cross-tenant email collision.** Two tenants with the same admin email
  causes the login flow to reject with a generic error (no tenant
  picker). Tenant picker UI is queued.
- **No password-reset flow.** Admins set passwords via seed/admin panel.
- **No rate limiting** on `/auth/login`. Add Redis-backed sliding-window
  limiter when the first non-dev deployment happens.
- **No RLS yet.** Tenant context is enforced in application code; database
  rows are not yet protected by Postgres RLS policies. Adding RLS is
  trivial structurally — every table already has `tenant_id` — and is
  queued for the iteration where the first non-auth domain module lands.

## Triggers for re-evaluation

- A second backend service appears → split key material, move to RS256.
- A token compromise incident → ship sessions + revocation immediately.
- Compliance requirement (SOC 2, ISO 27001) → bring forward MFA, rate
  limiting, and stricter session management.
