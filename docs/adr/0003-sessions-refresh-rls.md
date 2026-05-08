# ADR-0003: Server-side sessions, refresh-token rotation, and Postgres RLS

**Status:** Accepted
**Date:** 2026-05-08
**Supersedes:** —
**Amends:** ADR-0002

## Context

ADR-0002 shipped a working but deliberately MVP-grade auth surface: a single
1-day stateless JWT, no refresh, no server-side session, no row-level
isolation in the database. The known gaps were called out and queued.

This ADR closes the remaining auth-correctness gaps before any business
module is built on top:

1. **Stale-token blast radius.** A 24h JWT means a stolen token is good
   for up to 24 hours regardless of any user action.
2. **No revocation.** Logout was a no-op — the token kept working until
   it expired naturally.
3. **No theft signal.** Refresh tokens were not in scope yet, so we had
   no way to detect that someone else was using a user's credentials.
4. **No DB-level tenant isolation.** Tenant separation lived only in
   application code; a service-layer bug or a missing `WHERE tenant_id`
   could expose cross-tenant data.

## Decision

### 1. Server-side sessions in `sessions` table

A new `sessions` row is created per login. Columns: `id`, `tenant_id`,
`user_id`, `family_id`, `parent_id`, `refresh_token_hash`, `ip`,
`user_agent`, `expires_at`, `last_used_at`, `revoked_at`,
`revoked_reason`. The session row is the source of truth for
"is this login still alive."

The access JWT now carries `sid` (session id); the request middleware
verifies that `sid` references an active row before populating
`req.tenantContext`. A revoked session means the access token is dead
within the next request, even though it's still cryptographically valid.

### 2. Refresh-token rotation with replay detection

Login issues a token bundle:

- **Access token** — JWT, 15 min, carries `sid`.
- **Refresh token** — 48 random bytes (URL-safe), single-use, 30-day
  expiry, stored as SHA-256 hash.

`POST /auth/refresh` rotates: the presented refresh is invalidated, a
new session row is inserted in the same `family_id`, and a fresh
access/refresh pair is returned. The old session row is updated with
`revoked_reason = 'rotation_superseded'`.

**Replay detection:** if the presented refresh hash points at an
already-revoked row, that's a theft signal — the rotated token is
single-use. We mark every active session in the same family with
`revoked_reason = 'rotation_replay'`. The current valid tokens belonging
to whoever just rotated normally are killed too: a small price for
revoking a confirmed-stolen session family.

Critical implementation detail: the family-burn UPDATE runs in an
**autonomous transaction** (`tenantDb.runPrivileged` opens a fresh
connection). The endpoint then throws 401, which rolls back the request's
own transaction — but the burn is already committed.

### 3. Logout is real

`POST /auth/logout` sets `revoked_at = now(), revoked_reason = 'logout'`
on the current session. Any further request with the access token is
rejected by the middleware (session not active).

### 4. Session management endpoints

- `GET /auth/sessions` — list the caller's active sessions; the current
  one is flagged. Lets a user audit their own sign-ins.
- `DELETE /auth/sessions/:id` — revoke any of their own non-current
  sessions. Returns 404 (not 403) for ids the caller doesn't own — RLS
  hides the row, so we can't distinguish "doesn't exist" from "not
  yours" without leaking information.

### 5. Auth.js auto-refresh

The web's `jwt` callback inspects `accessTokenExpiresAt` on every
session read. If less than 60 seconds remain, it calls `/auth/refresh`,
swaps the token bundle in the encrypted Auth.js cookie, and returns the
fresh token. A failed refresh sets `token.error = 'RefreshFailed'`; the
edge middleware treats sessions with `error` as anonymous and bounces
the user to `/login?reason=RefreshFailed`.

This is invisible to UI code: server components keep calling
`authedApiFetch`, which reads `session.accessToken` from `auth()` —
already refreshed.

### 6. Postgres Row-Level Security

A new migration (`0002_rls_policies.sql`) enables RLS on every
tenant-scoped table:

| Table       | Policy                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `users`     | `tenant_id = current_setting('app.tenant_id')` OR bypass                                                |
| `sessions`  | same                                                                                                    |
| `audit_log` | INSERT permissive (anonymous failures); SELECT scoped; UPDATE/DELETE blocked except in privileged scope |
| `tenants`   | no RLS — source-of-truth, queried by id/slug only                                                       |

`FORCE ROW LEVEL SECURITY` is set so the application's role (the table
owner) is also subject to policies — without that, owners would silently
bypass.

### 7. Per-request tenant scope: `TenantTransactionInterceptor`

A global Nest interceptor wraps every authenticated HTTP request in a
transaction with `SET LOCAL app.tenant_id = '...'`. Every query the
handler issues runs in this transaction; RLS does the filtering
automatically.

Services no longer hold a reference to a raw Drizzle client. They
inject **`TenantDatabaseService`** and call:

| Method                          | Purpose                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantDb.run(fn)`              | Run a query against the active request's tenant tx. Throws if no tx is active.                                                                                                                                                                                                |
| `tenantDb.runForTenant(id, fn)` | Open a new tenant-scoped tx (used by the interceptor; tests/jobs use this directly).                                                                                                                                                                                          |
| `tenantDb.runPrivileged(fn)`    | Open a tx with `app.bypass_rls = 'on'`. Used by login (cross-tenant user lookup), refresh (cross-tenant session lookup), audit's failure path, and the family-burn. **Try/finally resets the GUC so the bypass cannot leak via a Postgres SET-LOCAL-into-savepoint footgun.** |
| `tenantDb.unsafeRoot()`         | Returns the unwrapped Drizzle client. Loud warning logged on every call — only legitimate use is bootstrap/seed.                                                                                                                                                              |

### 8. Audit durability

`AuditService.record({ ..., durable: true })` writes through
`runPrivileged` instead of the caller's tx, so audits of failure events
that themselves throw (login denied, refresh replayed) survive the
request rollback. Success-path audits stay in the request tx — atomic
with the action they record.

## Consequences

**Positive:**

- 15-minute window for any stolen access token. Logout is real.
- Refresh-token theft is detected and confined: the attacker gets one
  rotation before the family burns down.
- Tenant isolation enforced by Postgres, not by trust in application code.
- Session-management UX (list, revoke, logout) is functional.
- Audit log is durable for the events that matter most (denials).

**Negative / known gaps:**

- **No Redis cache** for session-validity lookup yet. Every authenticated
  request does one indexed Postgres lookup on `sessions.id` — fine at
  current scale, will need caching when QPS rises.
- **No rate limiting** on `/auth/login` or `/auth/refresh`. Add Redis
  sliding-window limiter before the first non-dev deployment.
- **No MFA / no TOTP / no WebAuthn.** Queued.
- **No cross-tenant tenant picker** when one email belongs to multiple
  tenants. Login still rejects with a generic 401.
- **`tenants` table has no RLS** — application code only queries it by
  id/slug; if a future admin feature lists tenants we need to add RLS
  at that point.
- **Audit on success-path mutations is still tx-bound** by default.
  If a domain mutation succeeds at the DB level but the audit insert
  fails after, the request rolls back — auditing exception-paths
  uses `durable: true` but we haven't yet inverted the default. Real
  outbox-pattern audit is queued.

## Triggers for re-evaluation

- High auth QPS → add Redis-cached session lookups.
- First abuse incident → bring forward rate limiting and concurrent-
  session limits.
- Compliance certification scope (SOC 2 / ISO 27001) → require MFA, IP
  allowlists, anomaly detection.
- Per-tenant DB requirement → revisit the single-pool RLS model.
