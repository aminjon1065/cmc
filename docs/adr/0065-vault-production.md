# ADR-0065: Production Vault — AppRole/KV v2 auth + dynamic DB credentials (boot loaders)

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.7 (a — production auth; b — dynamic DB credentials)
**Builds on:** P2.14 / ADR-0044 (dev-mode KV secret loader)
**Reshapes scope of:** the original "P4.7 — Vault production (… mTLS service mesh / Linkerd)"

## Context

P2.14 introduced an in-process Vault loader that, at boot, reads a KV v2 secret
with a **static token** (dev-mode root token) and overlays it into `process.env`
before validation. Production needs more: a real auth method (not a root token)
and **short-lived database credentials** instead of a long-lived `DATABASE_URL`
password.

The original P4.7 also called for an mTLS **service mesh (Linkerd)**. Linkerd is
Kubernetes-only, and this deployment is **single-site docker-compose** (not k8s,
per the regional-segmentation reframe, ADR-0064). So Linkerd is **out of scope**;
mTLS/TLS to Postgres/Redis becomes a TLS-config follow-on.

## Decision

### 1. Production auth: AppRole + KV v2 (P4.7a)

The KV loader (`src/config/vault-secrets.ts`) gained a `VAULT_AUTH_METHOD`:
`token` (dev: `VAULT_TOKEN`) or `approle` (prod). AppRole performs the login
(`POST /v1/auth/{VAULT_APPROLE_MOUNT}/login` with `VAULT_ROLE_ID`+`VAULT_SECRET_ID`
→ `client_token`), then the KV v2 read uses the issued token. The token-resolution
step (`resolveVaultToken`) is exported and reused by the DB-credentials loader.
`token` stays the dev default → fully backward-compatible.

### 2. Dynamic DB credentials via the DB secrets engine (P4.7b)

A second boot loader (`src/config/vault-db-credentials.ts`), gated on
`VAULT_DB_CREDS_ENABLED`, leases short-lived Postgres credentials from
`{VAULT_DB_MOUNT}/creds/{VAULT_DB_ROLE}` and **swaps them into `DATABASE_URL`'s
userinfo** (host/port/database/query preserved). A background **renewer**
(`renewVaultLease`, started in `main.ts` at ~half the lease TTL) keeps the lease
alive up to its `max_ttl`. Off by default → static `DATABASE_URL`.

Design choices:
- **Boot-time env overlay** (mirrors the KV loader): runs before `loadConfig()`
  and the dynamic `AppModule` import, so every `ConfigService.get("DATABASE_URL")`
  is unchanged — the Drizzle pool just sees the leased creds. Pre-DI, so it is a
  plain async function with injectable `env`+`fetch` → hermetically testable.
- **Swap userinfo on the existing `DATABASE_URL`** rather than a new URL template:
  the operator keeps one connection shape; Vault supplies only user/password
  (the WHATWG `URL` setters percent-encode). Minimal new config.
- **`DATABASE_OWNER_URL` stays static** — the dynamic role is the app's runtime
  `cmc_app` connection, not the migration/bootstrap owner.
- **Secrets never logged** — only the username + lease TTL (never the password or
  the composed URL).

### 3. Linkerd deferred; mTLS → follow-on (P4.7)

Linkerd is recorded as **not applicable** to the single-site docker-compose
deployment. mTLS/TLS to Postgres/Redis (e.g. `sslmode=require` + CA) is a TLS
config follow-on, not a mesh.

## Consequences

- **Positive:** production auth (AppRole) with no static root token; per-process
  expiring DB creds with lease renewal; both loaders are gated, pre-DI, and
  hermetically tested; `ConfigService` + the DB pool stay unchanged; secrets are
  never logged; dev/test/CI need no Vault.
- **Negative / trade-offs:** the renewer keeps the lease alive to `max_ttl` but
  does **not** yet re-fetch + hot-swap the pool on expiry (full rotation =
  follow-on; size the role's `max_ttl` to the deploy/restart cadence); the
  renewer re-resolves a token per call (fine at ~half-TTL cadence); the real
  Vault DB engine is a **manual live-smoke**, not headless; k8s auth + Vault
  Agent sidecar remain deferred.

## Validation

- e2e `vault-secrets` **7/7** (P4.7a: token + AppRole login→KV + error paths) and
  `vault-db-credentials` **6/6** (P4.7b: gating, DB-engine read + userinfo swap,
  AppRole reuse, missing-role/URL errors, lease renew). Both hermetic (faked
  `fetch`+`env`). Full backend suite **60 suites / 432 tests**, zero regressions;
  `tsc`/eslint clean.
- **Boundary (manual/live):** real Vault AppRole + DB secrets engine against the
  dev-Vault container — set `VAULT_ENABLED`/`VAULT_DB_CREDS_ENABLED`, configure
  the engine + role, boot, confirm the pool connects with leased creds.

## Files

- `apps/api/src/config/vault-secrets.ts` (AppRole, exported `resolveVaultToken`),
  `apps/api/src/config/vault-db-credentials.ts` (lease + swap + renew),
  `apps/api/src/main.ts` (load after KV + renewer), `src/config/configuration.ts`
  (`VAULT_AUTH_METHOD`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID`/`VAULT_APPROLE_MOUNT` +
  `VAULT_DB_CREDS_ENABLED`/`VAULT_DB_MOUNT`/`VAULT_DB_ROLE`).

## Follow-ons

- Credential **rotation** (re-fetch + hot-swap the pool) on lease expiry.
- k8s auth method + Vault Agent sidecar.
- **mTLS/TLS** to Postgres + Redis (`sslmode=require` + CA) — the Linkerd
  replacement for single-site.
- Backup-encryption via Vault Transit (noted since P2.14).
