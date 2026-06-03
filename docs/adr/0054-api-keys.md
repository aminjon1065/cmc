# ADR-0054: API keys + combined JWT/API-key auth + per-tenant quota

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.9 (a: backend; b: web admin UI)
**Depends on:** RBAC (P1.1 / ADR-0019), tenant-context middleware + RLS (P0), Redis rate-limit (P0.1), audit (P1.11)

## Context

ToR §11.5 needs programmatic API access. The plan flagged a "Caddy/Kong
decision". Four points were confirmed with the user: **in-app NestJS guard**
(no external gateway — consistent with the in-app RBAC/rate-limit/RLS already in
place), **combined JWT-or-API-key on the existing `/v1`** (a key calls the same
endpoints, not a parallel surface), **permission-subset scopes** (a key carries
RBAC permission strings, ≤ the creator's), and **per-key + per-tenant Redis
quota**.

## Decision

### Storage + minting (P3.9a)

`api_keys` stores only the **SHA-256 hash** of the secret (`cmc_` + 32 random
url-safe chars) — same posture as session/reset tokens; the plaintext is
returned **once** at creation. `key_prefix` (`cmc_xxxxxxxx`) is the public,
displayable identifier. SHA-256 (not a slow KDF) is correct: the secret is
high-entropy random, so there's nothing to brute-force and auth must be a fast
indexed lookup (unique index on `key_hash`). `scopes` is a jsonb array of
permission strings; `ApiKeysService.create` rejects any scope the creator
doesn't hold (**no privilege escalation**, enforced even for tenant_admin).

### Combined auth (the key decision)

JWT verification already happens in `TenantContextMiddleware`, with guards
trusting `req.tenantContext`. So API-key auth slots in there: the middleware
detects a key (`X-API-Key`, or `Authorization: Bearer cmc_…`), does a privileged
indexed hash lookup (the tenant isn't known yet — same as the session check),
validates not-revoked / not-expired / has-creator, and sets a tenant context
with `principalType: "apikey"` carrying the key's `scopes` (+ the creator's user
id, so user-FK writes and audit attribution work). One change in
`RbacService.resolvePermissions` makes the whole RBAC layer honour the key:
for an api-key principal it returns the **scopes** (resolved **before the cache**
so the creator's role-permission cache is never read or poisoned). Because
`enforce`, `hasPermission`, and every domain filter route through
`resolvePermissions`, the same `/v1` endpoints — and downstream per-permission
filtering (search, folder-access) — are correctly scoped with **zero
per-controller changes**.

### Quota

A global `ApiKeyQuotaGuard` (no-op for JWT/anonymous) consumes two Redis
fixed-window counters per request — per-key and per-tenant — via the existing
`RateLimitService`; a breach throws `RateLimitExceededError`, which the HTTP
filter renders as `429` + `Retry-After`. Limits are configurable
(`API_KEY_RATE_*`).

### Management + UI

`/v1/api-keys` (create/list/revoke), `api_key:manage`-gated and **user-only** —
an api-key principal is rejected so a key can never mint or revoke keys
(lateral-escalation guard, on top of the scope-cap). Web `/admin/api-keys`
(P3.9b, under the admin-only layout): create with a scope picker drawn from the
caller's own permissions, the secret shown once with copy, a list (prefix /
scopes / last-used / status), and revoke.

## Consequences

**Positive**
- Programmatic clients use the full existing API with fine-grained, least-
  privilege scopes — no separate surface to maintain, no new gateway to run.
- Secrets are unrecoverable at rest; revocation is immediate; quota throttles a
  noisy key without affecting interactive users (separate counters).
- The whole integration is ~one middleware branch + one `resolvePermissions`
  branch + a global guard — the blast radius on existing auth is tiny, and the
  full JWT suite proves no regression.

**Negative / deferred**
- **In-app only** — no Kong/Envoy/WAF; the Caddy edge + this guard are the
  gateway. A managed gateway remains a later option.
- **No key rotation / scope-edit** — revoke + re-create instead.
- **`last_used_at` is best-effort** (fire-and-forget write per request); fine
  for "last seen", not an exact call ledger.
- **Quota is fixed-window** (same primitive as auth limits), not a token bucket.
- Key management is user-only (keys can't manage keys) — intentional.

## Validation

- **API suite**: 359/359, 49 suites (+8). e2e `api-keys` (real HTTP): create
  (secret once, **`key_hash` = sha256(secret)** at rest), authenticate a `/v1`
  endpoint within scopes (via `X-API-Key` and `Bearer cmc_…`), `403` outside
  scopes, scope-overreach → `400`, revoke → `401`, **quota → `429` +
  `Retry-After`**, management gated (operator `403`, api-key principal `403`),
  **JWT path unaffected**. Migration `0027`.
- **Web**: `next lint` + `next build` clean (`/admin/api-keys` built). Runtime
  smoke: `/admin/api-keys` unauthenticated → 307 → `/login` (admin gate live).
- **Build/lint**: contracts + API `tsc`, `nest build`, `eslint` clean.
- Env note: a macOS TCC / Docker file-share glitch revoked repo file access
  mid-item; after restoring access the eslint/build/full-suite gates were re-run
  clean (the e2e had already passed before the glitch).
