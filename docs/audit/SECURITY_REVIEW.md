# SECURITY REVIEW
## Posture audit against ToR §6 + OWASP-aligned checks

**Audit date:** 2026-05-24.
**Scope:** code as of `45d100e` (tag `0.0.1`).
**Method:** code review against the ToR's security architecture (§6) + OWASP Top-10 + ASVS-style checks.

**Verdict:** the parts of the security posture that exist are **above the maturity curve for greenfield platforms at this code volume**. The parts that do not exist are **show-stoppers for any non-dev deployment**.

---

## 1. Authentication

### 1.1 Password handling — `apps/api/src/modules/auth/auth.service.ts:267-274`

- **Argon2id** with parameters `memoryCost=19 MiB, timeCost=2, parallelism=1`. Matches OWASP 2023 minimum recommendation.
- Verification calls go through `argon2.verify(hash, password)` which is constant-time.
- **Constant-time dummy verify** on the no-user code path (`dummyVerify`, line 291) using a fixed argon2 hash. Login-timing does not leak account existence.
- Wrong-password path also goes through a real `argon2.verify`. Timing parity holds.

**Gap:** no **per-tenant pepper** (ToR §6.10 mentions per-tenant pepper). Adding it now (before user volumes grow) is cheap: a per-tenant `password_pepper` column on `tenants` + concatenate before verify. Not yet implemented.

**Risk:** Low. Argon2id without pepper is still strong; pepper hardens against an attacker who has both the DB *and* knows tenant context.

### 1.2 Session model — `apps/api/src/modules/auth/sessions.service.ts`

- Each login → one row in `sessions` (id, family_id, parent_id, refresh_token_hash, ip, user_agent, expires_at, last_used_at, revoked_at, revoked_reason).
- Access JWT carries `sid` claim → middleware verifies session still active before populating tenant context. **A revoked session blocks the next request even though the JWT is cryptographically valid.**

### 1.3 Refresh-token rotation — `sessions.service.ts:194-278`

- Refresh tokens: 48 random bytes → `base64url`. SHA-256 hashed at rest.
- Rotation: presented token → look up row → if `revokedAt` is set, **replay detected → burn whole family** via autonomous `runPrivileged` transaction (so the burn commits even when the request later throws 401). Mints successor, marks predecessor `rotation_superseded`.
- **In-flight refresh dedup on the web side** (`apps/web/src/auth.ts:41`) prevents parallel RSC reads from each calling `/auth/refresh` and tripping replay detection on themselves.

This is **production-grade refresh-rotation**. Verified end-to-end by `auth.e2e-spec.ts` test "burns the entire family on refresh-token replay."

### 1.4 Logout — `auth.controller.ts:82-87`

- `POST /auth/logout` sets `revoked_at = now(), revoked_reason = 'logout'`. Next request rejected at middleware.
- Web side: Auth.js `signOut` event hits `/auth/logout` so the server-side session is killed even though the cookie is already client-cleared.

### 1.5 Session management endpoints — `auth.controller.ts:91-131`

- `GET /auth/sessions` lists active sessions (RLS filters tenant; service-layer filters by `userId`).
- `DELETE /auth/sessions/:id` returns **404 for ids not owned by the caller** to avoid leaking other users' session-ids. Refuses to revoke the current session (forces a real logout).

### 1.6 JWT internals

- HS256, 48-byte secret (`JWT_SECRET ≥ 32 chars` validated at boot).
- 15 min access lifetime (ADR-0003 — tight).
- 30 day refresh lifetime (ADR-0003).
- `issuer` pinned; verifier pins `algorithms: ["HS256"]` (no `alg: none` attack surface, no `RS256/HS256` confusion).
- Claims: `sub`, `tid`, `ts`, `sid`, `email`, `iat`, `exp`, `iss`.

**Gap:** HS256 + single secret is fine while the API is the only issuer + verifier. The moment a second service verifies (worker, WS gateway, integration), **must rotate to RS256 + JWKS endpoint + key rotation**. Called out in ADR-0002 §"Triggers for re-evaluation."

### 1.7 MFA — **absent.** S0 gap.

ToR §6.11 requires TOTP + WebAuthn + backup codes (and explicitly excludes SMS). None implemented. See [TECH_DEBT_REGISTER TD-002](./TECH_DEBT_REGISTER.md#td-002--no-mfa).

### 1.8 Rate limiting — ✅ **shipped 2026-05-25** (P0.1 / ADR-0009).

- Redis fixed-window counter on `/auth/login` (per-IP + per-email) and `/auth/refresh` (per-IP).
- Defaults: 30/5min IP login, 5/15min email login, 60/5min IP refresh — env-overridable.
- Breach → 429 + `Retry-After` + durable audit row (`outcome='denied'`, `metadata.reason='rate_limit_exceeded'`).
- Fail-open on Redis errors (rationale in ADR-0009).
- Trust-proxy posture limited to private networks so X-Forwarded-For can't be spoofed by external clients.
- Non-auth / global rate limit still pending → planned for P0.9 (Caddy at the edge).

### 1.9 SSO / federation — **absent.**

No OIDC server, no SAML, no SCIM, no JIT provisioning. Acceptable for current scope; required for the ministry-and-bank customers in ToR §1.4.

---

## 2. Authorization

### 2.1 Tenant isolation (Ring-0 of authorization)

**Strong.** Three interlocking mechanisms:

1. **PostgreSQL RLS** on every tenant-scoped table (`users`, `sessions`, `audit_log`, `documents`).
2. `FORCE ROW LEVEL SECURITY` so even the table owner respects the policies.
3. The runtime role `cmc_app` is `NOSUPERUSER NOBYPASSRLS`.

Validators in `packages/db/migrations/0002_rls_policies.sql`:
```sql
USING (
  current_setting('app.bypass_rls', true) = 'on'
  OR tenant_id::text = current_setting('app.tenant_id', true)
)
```

`app.tenant_id` is set at transaction entry via parameterised `set_config()` (Postgres bind, not string-concat — closed to SQL injection). The middleware also UUID-validates the value before issuing the SET.

`app.bypass_rls = 'on'` is the only escape hatch and is set only via `TenantDatabaseService.runPrivileged()`, which uses `try/finally` to reset the GUC and avoids the SET-LOCAL-into-savepoint footgun.

Regression-tested in `apps/api/test/e2e/rls.e2e-spec.ts`:
- `cmc_app.rolsuper === false`
- `cmc_app.rolbypassrls === false`
- All tenant-scoped tables have `relrowsecurity AND relforcerowsecurity === true`
- Cross-tenant `GET /documents/:other` returns 404; `DELETE` returns 404; row remains unchanged.

This is **the strongest part of the codebase.** The bug discovered in ADR-0004 (cmc role was a superuser → all RLS silently bypassed) is now a structural impossibility, regression-tested.

### 2.2 RBAC — **absent.** S0 gap.

No roles, no permissions, no `@Authorize` guard. Every authenticated user can perform every action available to its tenant. Within a tenant: every user can list every document, list every session, view every audit log row.

See [TD-003](./TECH_DEBT_REGISTER.md#td-003--no-rbac--every-authed-user-can-read-every-document).

### 2.3 ABAC — **absent.**

No OPA, no Rego, no PDP/PEP/PIP. Acceptable until RBAC is established; expected from Horizon 2 onward.

### 2.4 The `tenants` table

Not under RLS. Documented in `0002_rls_policies.sql` comment block. **Correct today** because the application code only queries by id or slug from validated token claims — there is no application path that lists tenants for a tenant user. **Becomes a latent risk** as soon as any admin feature lists tenants. The audit recommends adding RLS the moment such a path appears.

### 2.5 Service-to-service authentication

Single process today, no internal service calls between processes. ToR §6.16 zero-trust posture (mTLS service mesh, SPIFFE/SPIRE identity) is not yet relevant. Will need to land before the WS gateway is extracted (Roadmap P2.3).

---

## 3. Data protection

### 3.1 Encryption at rest

| Layer | State |
|---|---|
| Postgres filesystem | Depends on host (no LUKS / TDE configured in compose) |
| MinIO at rest | MinIO SSE-S3 not enabled in compose config |
| Application-level field encryption (PII) | Not implemented |
| Per-tenant DEK / envelope encryption | Not implemented |
| Backup encryption | N/A (no backups) |

**Risk:** Disk-level compromise yields readable data. Acceptable in single-tenant dev; not acceptable for ToR-named regulated customers.

**Remediation:**
1. Enable LUKS on the host disk in any non-dev deployment.
2. Enable MinIO SSE-S3 (autoEncryption on the bucket).
3. Application field encryption for PII as it lands (currently no PII beyond email + name).
4. Per-tenant DEK via Vault Transit when the multi-tenant phase starts (Roadmap P2.12 / Horizon 3).

### 3.2 Encryption in transit

- **External:** ADR-0001 names Caddy + Let's Encrypt at deploy step. Not in compose today.
- **Internal:** single process, no internal traffic.
- **DB:** Postgres connection is plain `postgresql://` — no `sslmode=require`. Within Docker network this is acceptable; once Postgres is on a separate host, **must enable TLS**.

**Risk:** any deployment that puts the API on a different host from Postgres without TLS is exposing credentials + traffic on the wire.

### 3.3 Secret management

- `apps/api/.env` carries `JWT_SECRET`, `DATABASE_URL` (with password), `S3_SECRET_KEY`, `SEED_ADMIN_PASSWORD`.
- `infra/.env` carries Postgres + Redis + MinIO root credentials.
- `.gitignore` excludes both files.
- CI workflow inlines secrets in env blocks (line 132–225 of ci.yml) — fine for dev secrets, **must** be GitHub Actions Secrets for any non-dev key material.

**Remediation:** Vault dev mode (Roadmap P2.12). Until then: rotate all `change_me` defaults before any non-dev deployment; ensure CI secrets live in GitHub Encrypted Secrets, not the workflow file.

### 3.4 Pre-signed URLs

- PUT and GET URLs include the bucket + key + signed expiry.
- `Content-Type` and `Content-Length` are bound into the signature for PUT (`storage.service.ts:62-68`). The signed length closes the door on "lie about size at init, upload more bytes than declared" — S3 enforces the signed length on receipt.
- `response-content-disposition` is sanitised in `sanitizeFilename()` (strips `\"\r\n\\` and truncates to 255). Closes header-injection via filename.
- Default TTL: 5 minutes upload, 5 minutes download. Conservative.

**Gap (TD-030):** the `sizeBytes` is **declared by the client at init**, validated against the configured max, and **then trusted to choose the size to sign with**. A client lying low ("I'll upload 10 bytes" but actually presents a smaller signed limit) can't exceed *that* size at upload — S3 enforces. But if a client lies high ("I'll upload 100 MB" — the configured max — and actually puts 1 byte), the bytes-already-on-disk problem doesn't arise but the bucket-size accounting is wrong. Quota enforcement at upload-init (per-tenant, per-day) is the durable fix.

### 3.5 Filename / content-type handling

- MIME validation is **shape-only** (`/^[a-z0-9!#$&\-^_.+]+\/[a-z0-9!#$&\-^_.+]+$/i`). Does not match an allowlist. Documents can claim any IANA shape.
- **No magic-byte sniffing** on the actual content. A `.exe` claiming `image/png` is accepted (TD-031).

**Recommendation:** finalize-side magic-byte verification using `file-type` over a range GET of the first 4 KB; reject on mismatch; per-tenant MIME allowlist policy.

### 3.6 SQL injection

- All queries via Drizzle parameterised queries.
- The one raw SQL fragment in the codebase is `select set_config('app.tenant_id', ${tenantId}, true)` — Drizzle's `sql` template binds `${tenantId}` as a parameter. The UUID regex in `runForTenant` is a belt-and-suspenders second check (TD-033).

**Verdict:** SQL injection structurally closed.

### 3.7 XSS

- Frontend is React; auto-escapes string children.
- No `dangerouslySetInnerHTML` in the codebase.
- One inline SVG with `dangerouslySetInnerHTML`-equivalent (the login mural) but it is fully static.
- The CDN-friendly tile URLs (when GIS lands) will need to be reviewed for any user-supplied content paths.

**Verdict:** XSS surface is low today.

### 3.8 CSRF

- Bearer-token API (no cookie auth on the API itself) — CSRF N/A for the API.
- The Auth.js cookie is `Set-Cookie` from `/api/auth/[...nextauth]` and is HTTPOnly + Secure-in-production + SameSite=Lax (Auth.js v5 defaults). Auth.js's CSRF token is built into the credentials flow.

**Verdict:** CSRF posture acceptable.

---

## 4. Audit & forensics

### 4.1 Coverage

Audit rows produced on:
- `user.login` (success / failure / denied — with reason)
- `auth.refresh` (success / failure / denied — with reason)
- `user.logout` (success)
- `document.upload_init` (success)
- `document.finalize` (success)
- `document.download` (success)
- `document.delete` (success)

**Gap:** no audit on session-list, session-revoke. No audit on read-only document list/get. ToR §3.15 ("denies always, allows sampled") implies the existing coverage is **right for reads** (no read-audit yet) but **incomplete for state changes** (every revoke should be audited).

### 4.2 Durability

The asymmetry is correct:
- **Success-path** writes piggyback the caller's tx (atomic with the action).
- **Failure-path** uses `durable: true` → writes through `runPrivileged` autonomous tx (survives the request rollback).

### 4.3 Tamper-evidence

- Columns `prev_event_hash`, `this_hash` exist on `audit_log`.
- **No service code populates them.** ToR §3.15 tamper-evident chain is therefore aspirational.

**Recommendation (P1.11):** per-tenant chain, SHA256 of canonical-JSON-of-row || prev_hash, daily Merkle root committed to MinIO Object Lock bucket.

### 4.4 WORM property

- RLS policy `audit_log_no_update` / `audit_log_no_delete` allow UPDATE/DELETE only when `current_setting('app.bypass_rls') = 'on'`.
- This is policy-level WORM. The application code itself can still flip `bypass_rls` and mutate. A separate **auditor role** (no `bypass_rls` setter) backed by Postgres role permissions would harden this.

**Risk:** medium. Today's threat model assumes the application code is trusted.

### 4.5 SIEM export

Not implemented. ToR §6.15 / §14.6 calls for Syslog RFC 5424 + CEF. Roadmap P1.12.

---

## 5. Network / edge

### 5.1 CORS

`apps/api/src/main.ts:23-26`:
```ts
app.enableCors({ origin: config.CORS_ORIGINS, credentials: true });
```
Default `CORS_ORIGINS=http://localhost:3000`. Strict allowlist. No wildcard. ToR §11.9 compliant.

### 5.2 Security headers

**Gap:** no helmet middleware, no Content-Security-Policy, no Referrer-Policy, no X-Frame-Options, no X-Content-Type-Options, no Strict-Transport-Security.

The Caddy reverse proxy (P0.9) is a natural place to add HSTS + STS-preload + the static security headers. Application-level CSP for the Next.js side via `next.config.ts` headers config.

### 5.3 WAF

Not present. ToR §3.17 / §11.7. Roadmap P3.x.

### 5.4 Rate limiting (non-auth)

Not present. Beyond the auth-endpoint rate limit, every endpoint is unbounded. ToR §11.8.

---

## 6. Frontend security

### 6.1 Auth.js session cookie

- Auth.js v5 with `session: { strategy: 'jwt' }`.
- API JWT and refresh token live inside the Auth.js session JWT (encrypted with `AUTH_SECRET`), wrapped in an HTTPOnly + Secure (in prod) + SameSite=Lax cookie.
- The browser JS context never sees the API JWT — protects against XSS-exfiltration.

### 6.2 `?next=` redirect handling — `apps/web/src/middleware.ts:25`

`loginUrl.searchParams.set("next", nextUrl.pathname + nextUrl.search);`

This sets `next` to the **pathname + search**, not an arbitrary URL. The downstream login form should reject `next` values that are not paths (`/...`). The login form's redirect handling is in `components/login-form.tsx` — not reviewed in detail here but worth a sanity check that the redirect uses **relative URLs only**.

### 6.3 Auth.js refresh dance

Race documented + mitigated by in-flight dedup map (`auth.ts:41`). Without it, two parallel RSC reads at the refresh boundary would each rotate the token — second rotation is replay, family burnt.

### 6.4 No client-side secrets

API base URL is the only `NEXT_PUBLIC_*` env. No keys leak to the browser.

---

## 7. Dependency / supply chain

- Dependabot weekly grouped PRs (npm + github-actions + docker).
- No SBOM generation.
- No Trivy / Grype container scan.
- No CodeQL / Semgrep / OSV-Scanner SAST.
- No DAST (OWASP ZAP).

**Risk:** Medium. The dep tree is current (latest NestJS, latest Next.js, latest Auth.js v5 beta). Active CVE surveillance is Dependabot-driven only.

**Remediation (TD-029):** add Trivy on the CI container build + Semgrep + osv-scanner.

---

## 8. Cryptographic key inventory

| Key | Algorithm | Length | Rotation | Storage |
|---|---|---|---|---|
| `JWT_SECRET` | HS256 (HMAC-SHA-256) | ≥ 32 chars (~256 bits when random) | None | `.env` file |
| `AUTH_SECRET` (Auth.js cookie encryption) | AES-GCM (Auth.js v5 default) | 32 bytes | None | `.env` file |
| Refresh tokens | n/a (random opaque) | 48 bytes → base64url; SHA-256 at rest | Per-use rotation | DB column `refresh_token_hash` |
| Password hash | Argon2id | m=19MB,t=2,p=1 | n/a | DB column `password_hash` |
| MinIO root credentials | n/a | Static | None | `.env` |
| Postgres `cmc_app` password | n/a | Static (`change_me` default in dev) | None | `.env` |

**Gaps:**
- No rotation procedure for `JWT_SECRET` / `AUTH_SECRET`. Manual rotation invalidates all sessions and Auth.js cookies. Acceptable today; documenting a runbook is cheap.
- No HSM / KMS-backed keys.
- No envelope encryption (per-tenant DEK ↔ KEK).

---

## 9. OWASP Top-10 (2021) scorecard

| # | Risk | Status |
|---|---|---|
| A01 | Broken Access Control | 🟡 Tenant isolation 🟢; within-tenant 🔴 (no RBAC) |
| A02 | Cryptographic Failures | 🟡 Argon2id ✓; TLS depends on deploy; field encryption ❌ |
| A03 | Injection | 🟢 Drizzle parameterised; class-validator whitelist; no raw SQL |
| A04 | Insecure Design | 🟢 ADRs document threat-model decisions; RLS-by-construction |
| A05 | Security Misconfiguration | 🟡 No helmet; no security headers; `change_me` placeholders |
| A06 | Vulnerable Components | 🟡 Dependabot only; no SAST/SCA gate |
| A07 | Identification & Auth Failures | 🟡 Strong primitives; **no rate limit**, **no MFA** |
| A08 | Software & Data Integrity | 🟢 lockfile (pnpm-lock.yaml); ❌ no SBOM, no signed images |
| A09 | Logging & Monitoring Failures | 🟡 Audit ✓ for core flows; ❌ no SIEM, no alerting |
| A10 | SSRF | 🟢 No user-supplied URL fetching in the API surface |

---

## 10. Compliance posture

| Framework | State |
|---|---|
| SOC 2 Type II | 🔴 No control mapping documented. Audit + access logging start; everything else 🔴. |
| ISO 27001 | 🔴 No ISMS docs. |
| GDPR | 🟡 Data subject access not implemented; tenant deletion not implemented; right-to-be-forgotten (cryptographic erasure) not implemented. |
| HIPAA | 🔴 No PHI segregation pattern. |
| Tajikistan data residency | 🟢 Self-hosted deployment satisfies residency by construction. |

---

## 11. Severity-ordered findings

### S0 — must fix before any non-dev deployment

| # | Title | Reference |
|---|---|---|
| 1 | ~~No rate limiting on auth endpoints~~ → **resolved** by P0.1 / ADR-0009 | TD-001 closed |
| 2 | No MFA | TD-002, P1.2 |
| 3 | No RBAC | TD-003, P1.1 |
| 4 | Secrets in `.env` files (production must source from Vault / GH Secrets) | TD-005, P2.12 |
| 5 | No backups | TD-004, P0.5 |
| 6 | No TLS strategy committed | TD-006, P0.9 |

### S1 — high priority

| # | Title | Reference |
|---|---|---|
| 7 | No security headers (CSP, HSTS, X-Frame-Options, etc.) | new |
| 8 | Audit hash chain absent | TD-011, P1.11 |
| 9 | No SAST / dependency / container scanning in CI | TD-029, P1.x |
| 10 | No SIEM export (Syslog/CEF) | TD-012 / new, P1.12 |
| 11 | No magic-byte MIME verification on uploads | TD-031 |
| 12 | No content-type allowlist per tenant | TD-031 |

### S2 — medium

| # | Title | Reference |
|---|---|---|
| 13 | `tenants` not under RLS — relies on no-list-endpoint convention | TD-017 |
| 14 | No per-tenant password pepper | new |
| 15 | No DPoP / token binding | new |
| 16 | No password reset flow | TD-037 |
| 17 | No anomaly detection (impossible travel, new device) | new |

### S3 — low

| # | Title | Reference |
|---|---|---|
| 18 | Audit metadata schema-less | TD-039 |
| 19 | No HSM/KMS-backed keys | new |
| 20 | `JWT_SECRET` / `AUTH_SECRET` rotation runbook | new |

---

## 12. Action plan summary

**Immediately (this week / this sprint):**
- P0.1 rate limit
- P0.5 backups
- P0.9 Caddy + TLS

**Before first external user:**
- P1.1 RBAC
- P1.2 MFA
- P1.11 audit hash chain
- Security headers via Caddy + Next.js config

**Before first regulated tenant:**
- SOC 2 control mapping
- Field-level encryption for PII
- Per-tenant DEK / KMS / Vault Transit
- SBOM + signed images + admission controllers
- Pen test cycle established

**Continuous:**
- Dependabot review weekly
- CVE response SLA documented
- Quarterly key-rotation drill

---

## 13. Closing observation

The security posture is **two-faced**: the parts that exist are well-engineered (RLS isolation, refresh-token rotation, durable audit on failure, argon2 with timing protection). The parts that don't exist are **not subtle** — no rate limit, no MFA, no RBAC, no audit chain.

This is the **correct shape** for a foundation: build the deep, hard-to-retrofit guarantees first (RLS, session model), build the shallow, easy-to-add controls (rate limit, MFA, RBAC) as cohorts of work that are individually 2–5 days each.

The **risk profile of the codebase tomorrow** depends entirely on whether the S0 items above are addressed before any non-dev deployment. Today the codebase **is not deployed externally** — the gap is harmless. The moment that changes, the S0 list becomes the deployment gate.
