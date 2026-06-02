# ADR-0044: Vault dev mode + in-process secret loader (first secret migration)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.14
**Depends on:** configuration (`loadConfig`), `main.ts` bootstrap

## Context

Secrets (DB password, JWT signing key, the MFA encryption key, S3 keys, …) live
in `.env` files today. P2.14 begins moving them into HashiCorp Vault so they're
centrally managed, rotatable, and never committed. This first cut adds Vault to
the dev stack and migrates **one** secret end-to-end as the proof of the seam.

Two decisions were confirmed with the user:
1. **In-process loader** (not a Vault Agent sidecar) — fits the existing sync
   config + gated-seam patterns and is fully testable in CI.
2. **`MFA_ENC_KEY` via static KV** as the first secret — it was already earmarked
   in `configuration.ts` for P2.14; static, self-contained, smallest blast radius.

## Decision

### Gated in-process loader → process.env overlay

`src/config/vault-secrets.ts` exports `loadVaultSecrets(env?, fetch?)`. When
`VAULT_ENABLED=true` it does a KV v2 read (`GET {VAULT_ADDR}/v1/{mount}/data/{path}`
with an `X-Vault-Token` header) and overlays every returned key into `process.env`
— Vault **wins over** anything dotenv placed there. Off by default → pure no-op,
so dev/test/CI need no Vault (the gated-seam convention used for NATS/ClickHouse/
BullMQ). It's a plain async function (not a Nest provider) because it must run
before the DI container exists; `env` and `fetch` are parameters so it is
hermetically testable. Key **names** are logged, never values.

The win: the rest of the app is untouched — `SecretBoxService` still does
`config.get("MFA_ENC_KEY")`; it simply receives the Vault-sourced value.

### Config gets VAULT_* knobs; MFA_ENC_KEY keeps its env fallback

`VAULT_ENABLED` (default false), `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_KV_MOUNT`
(`secret`), `VAULT_SECRET_PATH` (`cmc/api`). These are read raw from env by the
loader (chicken-and-egg: they can't come from Vault). `MFA_ENC_KEY` keeps its dev
default so env-only mode is unchanged.

### Dev compose: Vault dev mode + a one-shot seeder

`infra/docker-compose.yml` adds `vault` (`hashicorp/vault:1.15.6`, `server -dev`,
in-memory, auto-unsealed, fixed root token — **dev only**) and `vault-init`, a
one-shot that writes `secret/cmc/api` with `MFA_ENC_KEY`. Both are inert unless
the API opts in with `VAULT_ENABLED=true`.

### Gotcha that drove a structural change: validate-at-import

`@nestjs/config`'s `ConfigModule.forRoot({ validate })` runs `validate` (→
`loadConfig`) **at module-import time**. Because `main.ts` imported `AppModule`
statically at the top, `process.env` was validated *before* `bootstrap()` — and
thus before `loadVaultSecrets()` — ever ran, so the overlay was too late. Fixed
by importing `AppModule` (and the openapi helpers it reaches) **dynamically**
inside `bootstrap()`, after `loadVaultSecrets()`. This was caught by the live
smoke; the hermetic test couldn't see it (tests import `AppModule` directly).

## Consequences

**Positive**
- Secrets can come from Vault with **zero change** to how the app reads config.
- Adding more secrets later is just adding KV keys at `secret/cmc/api` — the
  loader overlays whatever it finds.
- Fail-fast + safe: `VAULT_ENABLED=true` without a token throws; a non-2xx Vault
  read throws; disabled → clean no-op.
- Verified live: with an intentionally-invalid `MFA_ENC_KEY` in env, the API
  **fails to boot** with Vault off, and **boots** with Vault on (the Vault value
  overrode the bad env value before validation).

**Negative / deferred (the prod vision)**
- **Static KV only** — the **dynamic database-secrets engine** (short-lived
  `cmc_app` credentials with lease renewal + reconnection on rotation) and the
  **per-pod credential lease** the plan calls for are a dedicated follow-on.
- **Token auth only** — prod should use **AppRole** or **Kubernetes auth**, not a
  static token; and a **Vault Agent sidecar** (templated files) is the canonical
  k8s delivery. Documented here as the next step.
- **No runtime refresh** — secrets are read once at boot; rotation needs a
  restart (acceptable for `MFA_ENC_KEY`; not for dynamic DB creds).
- **Single secret path** — one `VAULT_SECRET_PATH`; multi-path / per-module
  secrets are a later extension.
- Dev Vault is **in-memory** — restarting it drops the seeded secret (re-run
  `vault-init`).

## Validation

- **Suite**: 279/279, 37 suites (+5). `vault-secrets` (5): no-op when disabled;
  KV v2 read overlays keys (correct URL + token header) and Vault overrides env;
  throws without a token; throws on a non-OK response; tolerates an empty secret.
  All hermetic (faked `fetch` + `env`, no Vault container).
- **Live smoke** (real `hashicorp/vault:1.15.6` dev container, `vault-init`
  seeded `secret/cmc/api`): with `MFA_ENC_KEY=too-short` in env — **Vault off →
  boot fails** (`must be 32 bytes`); **Vault on → loader logs
  `loaded 1 secret(s) … MFA_ENC_KEY`, app boots, `/health` 200**.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration.
