# ADR-0021: Password reset flow

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.3
**Closes tech-debt:** TD-037
**Depends on:** ADR-0003 (sessions/RLS), ADR-0009 (auth rate-limit), ADR-0019 (RBAC)
**Unblocks:** P1.6 (email channel swaps in the SMTP notifier)

## Context

There was no way to recover an account. A user who forgot their password,
or an admin who needed to rotate a compromised one, had no path short of a
SQL `UPDATE`. TD-037 flagged it. P1.3 adds two entry points over one
single-use, hashed token: a self-service "forgot password" flow and an
admin-initiated reset. The email channel that delivers the self-service
token does not exist yet (P1.6), so delivery is abstracted behind a
pluggable notifier whose only binding today logs the link in dev.

## Decision

### 1. One hashed, single-use token table (`password_resets`)

A reset is a row in `password_resets`: `user_id`, `tenant_id`,
`token_hash`, `expires_at`, `used_at`, `created_by`. The token is a random
256-bit secret (`randomBytes(32).toString("base64url")`); only its
**sha256 hash** is stored — exactly like refresh tokens (ADR-0003), so a DB
dump cannot be used to reset a password. A row is valid while
`used_at IS NULL AND expires_at > now()`. TTL is `PASSWORD_RESET_TTL_SEC`
(default 1h) — short by design, since a leaked token is only useful within
the window. Minting a new token burns any prior unused one for that user
(one live token at a time). `created_by` distinguishes admin-initiated
(the admin's id) from self-initiated (null).

The table is tenant-isolated via RLS using the same two-GUC pattern as
ADR-0003 (`bypass_rls` OR `tenant_id = app.tenant_id`), `FORCE ROW LEVEL
SECURITY` on.

### 2. Self-service flow does not enumerate accounts

`POST /auth/password/forgot { email }` **always** returns `204`, whether or
not the email exists. The lookup runs in a **privileged** transaction
(there's no tenant context pre-auth — same pattern as the login
cross-tenant lookup). Only when the email maps to **exactly one** active
user is a token minted and handed to the notifier. Zero matches (no such
account) and an ambiguous match (the same email in two tenants) are both
silent no-ops — the response never reveals the difference, so the endpoint
cannot be used to probe which addresses have accounts.

### 3. Admin-initiated returns the token over the authenticated channel

`POST /auth/password/admin-reset/:userId` runs inside the admin's **tenant**
transaction, so RLS confines the target lookup to the admin's own tenant —
an admin cannot reset a user in another tenant (a cross-tenant target is a
`404`, indistinguishable from "doesn't exist"). It returns
`{ token, expiresAt }` directly to the admin, who relays it out-of-band; no
email channel is required. The route is gated by a new `user:manage`
permission (see §6).

### 4. Completion is shared, race-safe, and revokes sessions

`POST /auth/password/reset { token, newPassword }` serves both flows. It
runs privileged (no tenant context). A cheap pre-check rejects an
obviously-bad token **before** spending an argon2 hash (a hash-DoS guard on
top of the per-IP rate limit). The argon2id hash (reusing
`AuthService.hashPassword`) is computed **outside** any transaction so a
connection isn't pinned for ~50ms. Then, in one privileged transaction:

1. A compare-and-swap `UPDATE ... SET used_at = now() WHERE id = $1 AND
   used_at IS NULL AND expires_at > now() RETURNING id` atomically consumes
   the token — this is the single-use guarantee, and it also wins the race
   against a concurrent completion of the same token (the loser gets 0 rows
   → 400).
2. The new password hash is written.
3. **All** the user's sessions are revoked (`revokeAllForUser`, reason
   `password_reset`) + their session-active cache entries deleted — a reset
   forces a fresh login everywhere, killing any attacker session.

All three are atomic in the same transaction. Invalid/expired/used tokens
return a **generic** `400 "Invalid or expired reset token"` that does not
disclose which of the three it was.

### 5. A reset changes ONLY the password — MFA stays

Resetting the password deliberately does **not** touch any MFA factor. A
user with TOTP enrolled who resets their password still passes the MFA gate
at the next login (verified live + in e2e). This preserves the second
factor through a password recovery and avoids turning "I forgot my
password" into an MFA-bypass. Admin removal of a user's MFA is a separate,
explicit Admin-Panel action (P1.4), not a side effect of a reset.

### 6. New `user:manage` permission

Admin-reset is gated by a new catalog permission `user:manage` ("Manage
users: initiate password resets, (de)activate"). `tenant_admin` (which
holds `*`) gets it automatically; `operator` and `auditor` do **not** —
verified live (operator → `403`). This is the first entry in a `user`
permission domain that the Admin Panel (P1.4) will extend.

### 7. Pluggable delivery channel (dev logger now, SMTP at P1.6)

How the self-service token reaches the user is behind a
`PasswordResetNotifier` interface, bound by the `PASSWORD_RESET_NOTIFIER`
symbol. The only implementation today, `DevLogResetNotifier`, **logs** the
reset link — the only way to obtain a self-service token before the email
channel exists. It **refuses to log in production** (warns and drops)
so a misconfigured prod deploy can't leak working reset links to stdout;
admins retain the admin-reset path, which delivers over an authenticated
channel. At P1.6 the SMTP notifier replaces this binding — one `useClass`
line in `PasswordResetModule`, no service change.

### 8. Rate-limited, audited

Reusing the ADR-0009 spec factory: `/auth/password/forgot` is limited
per-IP **and** per-email (`PASSWORD_RESET_EMAIL_LIMIT`=3/h — the anti-spam
control, since each request may send a notification); `/auth/password/reset`
is limited per-IP to bound token brute-force on top of the token's 256-bit
entropy. Every transition is audited: `password.reset_requested` (channel
self/admin) and `password.reset_completed` (success, atomic with the
change; failures durable so they survive the rejecting request's rollback).

## Consequences

**Positive:**

- TD-037 retired — account recovery exists for both users and admins.
  Verified live end-to-end (forgot → dev-logged link → reset → old pw 401,
  new pw 200; reuse 400) and across 11 e2e tests; full suite **111/111**,
  zero regressions.
- Tokens are hashed at rest and single-use; a DB dump can't reset a
  password, and the CAS consume is race-safe.
- A reset revokes every session, so recovering a hijacked account also
  evicts the attacker.
- MFA survives a reset — password recovery is not an MFA bypass.
- The notifier seam means P1.6 is a one-line binding swap, and the service
  is already testable (the e2e capturing-notifier proves the round trip).

**Negative / known gaps:**

- **No email yet** — the self-service token is only delivered by the dev
  logger; in production today, self-service is effectively inert (the
  notifier drops the message) and admins must use admin-reset. P1.6 closes
  this.
- **Ambiguous-email self-reset is a silent no-op** — if the same address
  exists in two tenants, forgot-password can't safely pick one and does
  nothing. Rare, but such a user can only be recovered by an admin. A
  tenant hint on the forgot form would resolve it later.
- **Password policy is min-8** — reuse of the login rule; no complexity,
  breach-list, or history checks. Hardening is future work (own TD if
  prioritised).
- **Notifier is fire-and-forget** — a delivery failure isn't retried; once
  email lands (P1.6) it should move onto the reliable-outbox path with the
  audit writer.

## Triggers for re-evaluation

- Email channel lands (P1.6) → bind the SMTP notifier; move delivery onto a
  retriable outbox; consider dropping the dev logger to test-only.
- Admin Panel (P1.4) → surface admin-reset in the UI; add the "reset a
  user's MFA" action that this flow deliberately omits; extend the `user`
  permission domain.
- Password-policy hardening prioritised → add complexity/breach-list/history
  checks at the `newPassword` boundary (shared with login + signup).

## References

- [PRIORITY_EXECUTION_PLAN P1.3](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-037](../audit/TECH_DEBT_REGISTER.md)
- [ADR-0003](./0003-sessions-refresh-rls.md) — hashed-token + RLS pattern reused
- [ADR-0009](./0009-auth-rate-limiting.md) — rate-limit spec factory reused
- [ADR-0019](./0019-rbac.md) — `user:manage` gate on admin-reset
- [ADR-0020](./0020-mfa-totp.md) — MFA, deliberately untouched by a reset
