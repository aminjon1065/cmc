# ADR-0020: Multi-factor authentication (TOTP)

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P1.2
**Closes tech-debt:** TD-002
**Depends on:** ADR-0003 (sessions/RLS), ADR-0009 (auth rate-limit)
**Unblocks:** P1.3 (compliance posture)

## Context

Authentication was single-factor (password only). ToR §6.11 makes
multi-factor the default, and §1.4's customer classes (public sector,
critical infrastructure, financial) require it. TD-002 (S0) flagged it.
P1.2 adds TOTP (RFC 6238) as the first factor — the cheapest, works with
any authenticator app — plus one-time backup codes for recovery.

## Decision

### 1. Two-step login via a stateless `mfa_token` (no half-sessions)

When a user with a verified TOTP factor logs in:

1. `POST /auth/login` verifies the password, then — instead of issuing a
   session — returns `{ status: "mfa_required", mfaToken, expiresInSec }`.
   `mfaToken` is a short-lived JWT (`scope: "mfa"`, `sub`, `tid`, TTL
   `MFA_TOKEN_TTL_SEC`=300s) signed with the existing `JWT_SECRET`.
2. `POST /auth/mfa/verify { mfaToken, code }` validates the token's scope,
   verifies the TOTP (or a backup code), and only THEN issues the real
   session + token bundle.

Chosen over a DB "pending_mfa" session row: the mfa_token is **stateless**
— no half-built sessions to store, cache (ADR-0011), revoke, or clean up,
and the `sessions` table keeps a single meaning ("an authenticated
session"). The login success path and the post-verify path share one
private `issueSession()` so the two routes can't drift.

Users **without** MFA still get the token bundle directly from
`/auth/login`, now tagged `status: "ok"`. The `status` discriminator was
added as an optional/defaulted field on `LoginResponse`, so existing
consumers that ignore it keep working (verified: full suite 100/100 with
no contract-break fixes).

### 2. TOTP secret encrypted at rest (AES-256-GCM)

The base32 secret is stored as `secret_encrypted` — AES-256-GCM ciphertext
(IV‖tag‖ciphertext, base64) via `SecretBoxService`, keyed by `MFA_ENC_KEY`
(32-byte base64 env). A database dump therefore does NOT hand an attacker
every user's TOTP seed. GCM's auth tag makes tampering detectable.

`MFA_ENC_KEY` has a **fixed, public dev default** (fine for local/CI) that
**must** be overridden in any real deploy; it moves to Vault at P2.14
(TD-005). The key is validated at boot to decode to exactly 32 bytes, so a
short/garbage key fails fast.

### 3. Confirm-before-active enrolment

`POST /auth/mfa/enrol` stores an **unverified** method and returns the
secret + `otpauth://` URI + a QR data-URL. The factor does NOT gate login
until `POST /auth/mfa/confirm` succeeds with a first valid code, which
sets `verified_at` and issues the backup codes. This prevents a user from
locking themselves out by enrolling a misconfigured authenticator. Status
distinguishes `pending` (enrolled, unconfirmed) from `enabled` (verified).

### 4. Backup codes: one-time, argon2-hashed

On confirm, `MFA_BACKUP_CODE_COUNT` (10) codes are generated
(`xxxxx-xxxxx` hex), returned plaintext **once**, and stored as argon2id
hashes (like passwords). `verifyForUser` tries the TOTP first, then falls
back to consuming an unused backup code (argon2 compare → mark `used_at`).
A code works exactly once — verified live (first 200, reuse 401).
Regenerate replaces the whole set.

### 5. Login-path helpers take an explicit `tx`

The mfa-gate runs inside the login's **privileged** transaction (login
predates tenant context). So `MfaService.isMfaEnabled(tx, ...)` and
`verifyForUser(tx, ...)` take the caller's transaction explicitly, while
the authenticated management methods (enrol/confirm/status/disable) open
their own tenant-scoped `.run()` tx. RLS isolates both tables; the bypass
branch covers the pre-auth login reads.

### 6. Rate-limited second step + audited

`/auth/mfa/verify` reuses the per-IP login rate-limit bucket (ADR-0009),
keyed additionally on the mfa_token tail, so TOTP/backup guessing can't be
brute-forced. Every transition is audited: `mfa.enrol.started`,
`mfa.enrol.confirmed`, `mfa.backup_codes.regenerated`, `mfa.disabled`, the
`password_ok_mfa_required` login step, and durable `user.mfa_verify`
failures.

### 7. No SMS (per ToR §6.11)

TOTP + backup codes only. SMS is excluded by policy — per-message billed,
SIM-swap/SS7 vulnerable, unavailable in airgapped deployments. WebAuthn/
FIDO2 is the planned second factor (future), not in this iteration.

### 8. otplib v12 (CJS), not v13 (ESM)

otplib 13 is ESM-first and pulls in an ESM-only `@scure/base` that the
CommonJS jest + ts-jest setup cannot parse (the suite failed to load).
Pinned **otplib@^12** (the classic `authenticator` CJS API), which is
jest-compatible and battle-tested. `authenticator.options = { window: 1 }`
allows ±1 time step (±30s) of clock skew.

## Consequences

**Positive:**

- TD-002 retired — multi-factor auth exists. Verified live end-to-end:
  enrol → confirm (10 backup codes) → login returns `mfa_required` (no
  session) → verify TOTP issues a session; backup code one-time; disable
  reverts to single-step. Full suite 100/100, +8 MFA tests, zero
  regressions.
- Secrets are encrypted at rest; a DB dump doesn't leak TOTP seeds.
- The stateless mfa_token keeps the session model clean — no new session
  state machine.
- The two-step contract is additive (`status` discriminator), so the web
  client + existing tests needed no breaking change.

**Negative / known gaps:**

- **`MFA_ENC_KEY` lives in env** (with a public dev default). Real deploys
  must override it; Vault migration is P2.14 (TD-005). A key rotation
  story (re-encrypt secrets) is not built — rotating the key today
  invalidates existing factors (users re-enrol).
- **No MFA enforcement policy** — MFA is opt-in per user; there's no
  per-tenant/per-role "MFA required" gate yet. That's an Admin Panel
  (P1.4) + policy concern.
- **No web enrolment UI** — enrol/confirm/manage are API-only this
  iteration (deliberately scoped out). The QR data-URL is ready for a
  future settings page.
- **No WebAuthn** — TOTP only. WebAuthn/FIDO2 is a later factor.
- **otplib pinned to v12** — a major-version behind, to stay CJS/jest
  compatible. Revisit if the test runner moves to native ESM.
- **No "remember this device"** — every login with MFA requires the
  second step. Trusted-device skipping is future hardening.
- **mfa_token reuse within its TTL** — a captured mfa_token could be
  replayed until expiry if also paired with a valid code; bounded by the
  300s TTL and the rate limit. A single-use jti could tighten this later.

## Triggers for re-evaluation

- Vault lands (P2.14) → source `MFA_ENC_KEY` from Vault; add a key-rotation
  re-encryption job.
- Admin Panel (P1.4) → add per-tenant/role "MFA required" enforcement +
  an admin "reset a user's MFA" action; build the web enrolment UI.
- High-assurance tenants ask for hardware factors → add WebAuthn/FIDO2 as
  a second `kind` in `user_mfa_methods` (the schema already keys on kind).
- Test runner moves to native ESM → re-evaluate otplib v13 (functional
  API) to drop the major-version pin.

## References

- [PRIORITY_EXECUTION_PLAN P1.2](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-002](../audit/TECH_DEBT_REGISTER.md) (+ TD-005 secrets/Vault)
- [ADR-0003](./0003-sessions-refresh-rls.md) — session model the verify step issues into
- [ADR-0009](./0009-auth-rate-limiting.md) — rate-limit reused on /auth/mfa/verify
- ToR §6.11 (MFA: TOTP/WebAuthn/backup codes, no SMS)
