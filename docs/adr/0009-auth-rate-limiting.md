# ADR-0009: Auth-endpoint rate limiting

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.1
**Closes tech-debt:** TD-001
**Depends on:** ADR-0008 (Redis as tier-1 dependency)

## Context

ADR-0002 and ADR-0003 shipped the auth substrate but explicitly left
rate limiting on the queue. Without it:

- `POST /auth/login` is open to online credential brute-force; a botnet
  with 10 RPS against a single email can guess any 6-digit-ish password
  in tens of minutes.
- `POST /auth/refresh` is open to refresh-token enumeration; an attacker
  who knows part of the token format can spray candidates.
- The session model (ADR-0003) detects refresh-token *theft* via replay
  rotation, but does nothing against an attacker who simply guesses
  new ones at high speed.

P0.2 (ADR-0008) wired Redis. P0.1 adds the rate-limit substrate on top.

## Decision

### 1. Algorithm: Redis fixed-window counter

- `INCR key` on every attempt.
- `EXPIRE key window NX` so the TTL is set only on first hit of the
  window. Without `NX`, every subsequent INCR would extend the TTL —
  the well-known "rolling on every hit" bug — and the counter would
  never reset.
- Both ops in a single `MULTI` for atomicity.

Rejected alternatives:

- **Sliding-window log** (ZADD timestamps + ZREMRANGEBYSCORE old + ZCARD).
  More accurate but the threat we are blocking is sustained brute-force,
  not edge-of-window bursts. The accuracy gain is not worth the memory.
- **Token bucket** (Lua-script INCR + refill). Better for variable
  legitimate traffic, but auth traffic is not naturally bursty for a
  single user — bursts mean abuse.
- **Express middleware `express-rate-limit`**. Couples us to a library
  with its own opinions about response shape and would not let us write
  durable audit on breach the way our service does.

### 2. Two parallel keys per login

For `POST /auth/login`:

- `cmc:auth:rate-limit:login:ip:<ip>` — bounds attempts per source IP.
  Defends against one host trying many emails (credential stuffing).
- `cmc:auth:rate-limit:login:email:<sha256(lowercased-email)>` — bounds
  attempts per account, **across all IPs**. Defends against distributed
  botnet attacks on one account.

For `POST /auth/refresh`:

- `cmc:auth:rate-limit:refresh:ip:<ip>` only. Refresh has no email — the
  token itself is the credential.

The email is SHA-256-hashed before keying so plaintext PII never
appears in `KEYS` output, `MONITOR` traces, or RDB dumps.

### 3. Defaults (env-configurable)

| Env var | Default | Notes |
|---|---|---|
| `AUTH_LOGIN_IP_LIMIT` | `30` | per `AUTH_LOGIN_IP_WINDOW_SEC` (default 300 s) |
| `AUTH_LOGIN_EMAIL_LIMIT` | `5` | per `AUTH_LOGIN_EMAIL_WINDOW_SEC` (default 900 s) |
| `AUTH_REFRESH_IP_LIMIT` | `60` | per `AUTH_REFRESH_IP_WINDOW_SEC` (default 300 s) |

These match the OWASP "5 failed logins per email per 15 minutes" rule
of thumb and leave room for legitimate-user retries. Tenants under a
stricter policy can override per environment.

### 4. Count every attempt

Failures **and** successes increment the counter. Two reasons:

- Successful brute-force still **completes the attack** — limiting only
  failures means the attacker can keep going past the failure budget
  once they hit the right password.
- "Reset on success" patterns leak information about which credentials
  worked (an attacker watching the counter would know exactly when the
  password was right).

Legitimate users almost never approach the per-IP limit (30 per 5 min)
in normal use.

### 5. Increment **before** credentials check

The rate-limit `enforce` call is the first line in the controller, before
`AuthService.login(...)` even runs. This guarantees:

- A flood of failed-credential attempts cannot bypass throttling.
- An attacker who crashes `argon2.verify` (timing attack, hypothetical
  bug) cannot iterate without consuming counter budget.

### 6. Breach handling: 429 + Retry-After + durable audit

- HTTP 429 `Too Many Requests`.
- `Retry-After: <seconds>` header (HTTP standard); value = remaining
  TTL on the breached key.
- Body: `application/problem+json` with `limit_name` so the client can
  distinguish per-IP vs per-email breaches and render UX accordingly.
- **Audit log row** with `outcome='denied'`, `action='user.login' |
  'auth.refresh'`, `metadata={ reason: 'rate_limit_exceeded', limit_name,
  limit_key, limit, observed, window_sec, retry_after_sec, email? }`.
- The audit row is written via `AuditService.record({ durable: true })`
  → autonomous `runPrivileged` transaction so the audit commits even
  though the request returns a 4xx. Without `durable: true`, the audit
  insert would be invisible (the throttled request never reaches the
  controller's tenant-scoped transaction).

### 7. Fail-open on Redis errors

If Redis errors mid-check (`MULTI` returns no replies, connection
dropped between INCR and EXPIRE, ioredis throws), the service warn-logs
and **allows the request**. Rationale:

- Mid-request Redis failure is a transient infrastructure problem;
  blocking 100 % of auth traffic to "be safe" is self-inflicted DoS.
- The boot-time PING (ADR-0008) ensures Redis was reachable at app
  start. A mid-request failure means something unusual happened — the
  warn log makes it investigable.
- The audit log still captures the *credentials* side of any attack
  (the existing `auth.service.ts` audit on login outcomes), so
  brute-force during a Redis outage is not invisible — just unmetered.

The alternative (fail-closed) was considered and rejected: a single
Redis hiccup would lock every user out of auth, which is the worse
operational outcome.

### 8. Trust-proxy: private networks only

`apps/api/src/main.ts` (and `apps/api/test/helpers/test-app.ts`) sets
`app.set('trust proxy', 'loopback, linklocal, uniquelocal')`.

- Honors `X-Forwarded-For` only when the direct TCP peer is in the
  loopback / RFC1918 / link-local ranges (where Caddy / corporate LB
  will live in P0.9 and beyond).
- Refuses to trust forwarded headers from arbitrary external clients,
  which would let an attacker spoof their IP and bypass the per-IP
  counter.
- Safe before P0.9: no proxy means no forwarded header is trusted in
  practice, and `req.ip` falls back to the direct connection IP.

### 9. The "common" location of the service

`apps/api/src/common/rate-limit/` rather than under any specific
domain module. Reasoning:

- Rate-limit is cross-cutting: this same `RateLimitService` will host
  password-reset throttle (P1.3), document-upload throttle (later),
  and any future per-endpoint quota.
- Mirrors `common/tenant-context/` — both are platform primitives, not
  domain features.

The auth-specific spec factory (`AuthRateLimitSpecs`) lives in
`apps/api/src/modules/auth/` because the limit *values* and the key
*shape* (login uses email; refresh doesn't) are auth-domain concerns.

### 10. Test isolation

E2E tests share one Redis instance with dev. To prevent counter state
from leaking across cases, `truncateAll(sql, redis?)` now optionally
scans-and-deletes every key under `cmc:auth:rate-limit:*` when called
with a Redis client. All four existing suites that drive `/auth/login`
have been updated to pass the client. The new `rate-limit.e2e-spec.ts`
relies on the same helper.

## Consequences

**Positive:**

- TD-001 retired. Online brute-force on auth endpoints is now bounded.
- The platform's posture against credential-stuffing and refresh-token
  enumeration improves from "structurally exposed" to "structurally
  bounded".
- Every denial leaves a durable audit row, so investigators can
  reconstruct an attack timeline.
- `RateLimitService` is reusable for the next 3+ throttle consumers
  without further architecture work.

**Negative / known gaps:**

- **Volumetric DDoS still consumes API CPU.** The DTO `ValidationPipe`
  runs before the controller, so a flood of valid-shape requests still
  burns parse cycles before hitting the throttle. Real volumetric
  defence lives at the proxy layer (P0.9).
- **No global rate limit on non-auth endpoints.** Only `/auth/login`
  and `/auth/refresh` are guarded. Other endpoints (e.g.
  `/documents/upload-init`) can still be hit at unlimited RPS until
  P0.9 or a follow-up.
- **No CAPTCHA / progressive friction.** A repeated offender is still
  allowed to keep hitting the endpoint (each request just returns 429
  cheaply). For higher-trust deployments we may want to escalate to a
  temporary IP block or require CAPTCHA after N breaches.
- **Per-tenant overrides are not yet exposed.** A tenant under a
  stricter policy can only change defaults globally via env. A
  per-tenant config table comes when the multi-tenant operational
  surface lands (P1.4 admin panel).
- **No metrics yet.** Breach counts are visible only in the audit
  table. Prometheus counters wait for P0.7.

## Triggers for re-evaluation

- First production deployment experiences a credential-stuffing wave
  → tighten the per-IP defaults; consider IP-banlist integration.
- A legitimate-user complaint about being throttled → revisit windows;
  may indicate a misuse-pattern in the UI (e.g. retries on auto-refresh
  bug).
- A second consumer of `RateLimitService` (e.g. password-reset throttle)
  → re-evaluate whether the spec shape generalises cleanly. If not,
  promote the per-domain factory pattern.

## References

- [PRIORITY_EXECUTION_PLAN.md P0.1](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER.md TD-001](../audit/TECH_DEBT_REGISTER.md)
- [SECURITY_REVIEW.md §1.8](../audit/SECURITY_REVIEW.md)
- [ADR-0008](./0008-redis-tier-1-dependency.md)
