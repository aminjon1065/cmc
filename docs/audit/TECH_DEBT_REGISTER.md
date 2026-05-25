# TECH DEBT REGISTER

**Scope:** technical debt **already incurred** in the current code, excluding "module not yet built" (that lives in [`IMPLEMENTATION_TRACKER.md`](./IMPLEMENTATION_TRACKER.md)). This register captures shortcuts, deferrals, and known sub-optimalities the codebase has accepted.

**Severity ladder**
- **S0 — Blocking** — must be addressed before the next non-dev deployment.
- **S1 — High** — known correctness or security issue under realistic load.
- **S2 — Medium** — operational pain or eventual scaling cap.
- **S3 — Low** — quality-of-life or maintenance hygiene.

**Effort:** XS ≤ ½ d · S 1–2 d · M 3–5 d · L 1–2 wk · XL > 2 wk.

---

## Index

| # | Title | Severity | Effort | Area |
|---|---|---|---|---|
| TD-001 | No rate limiting on auth endpoints | ✅ RESOLVED 2026-05-25 (P0.1, ADR-0009) | S | Security |
| TD-002 | No MFA | S0 | M | Security |
| TD-003 | No RBAC — every authed user can read every document | S0 | M | Security |
| TD-004 | Postgres backups absent | ✅ RESOLVED 2026-05-25 (P0.5, ADR-0012) | S | Operations |
| TD-005 | Secrets in `.env` files in compose / CI | S0 | M | Security |
| TD-006 | No reverse proxy / TLS strategy committed (deferred to deploy) | S0 | S | Operations |
| TD-007 | Logs unstructured (text via NestJS default) | ✅ RESOLVED 2026-05-25 (P0.3, ADR-0010) | S | Observability |
| TD-008 | No `request_id` / `trace_id` populated | 🟡 PARTIAL — request_id ✅ (P0.3); trace_id deferred to P0.6 | S | Observability |
| TD-009 | No metrics endpoint / no Prometheus | S1 | S | Observability |
| TD-010 | Health check is liveness only — no dependency probes | S1 | XS | Operations |
| TD-011 | Audit-log hash chain columns exist but unpopulated | S1 | M | Security / compliance |
| TD-012 | Audit-write failures are swallowed, not retried | S1 | S | Reliability |
| TD-013 | Redis deployed but unused by app code | ✅ RESOLVED 2026-05-25 (P0.2, ADR-0008) | S | Performance |
| TD-014 | No `Idempotency-Key` header support on mutating endpoints | S2 | M | API contract |
| TD-015 | No API URL versioning (`/v1` prefix) | S2 | XS | API contract |
| TD-016 | No OpenAPI document generated | S2 | S | API contract / DX |
| TD-017 | `tenants` table not under RLS — relies on no-list-endpoint convention | S2 | XS | Security |
| TD-018 | Session-active lookup hits Postgres on every authenticated request | ✅ RESOLVED 2026-05-25 (P0.4, ADR-0011) | S | Performance |
| TD-019 | No connection pooler (PgBouncer) | S2 | S | Scaling |
| TD-020 | No outbox / event bus → cross-module reactions absent | S1 | L | Architecture |
| TD-021 | Tajikistan-CMC branding hardcoded in shared components | S2 | S | Multi-tenant readiness |
| TD-022 | Hardcoded demo data on dashboard | S2 | M | Product correctness |
| TD-023 | Frontend inline-styled — design system promised, not implemented | S2 | L | Frontend |
| TD-024 | No i18n / Russian/Tajik locale | S2 | L | Product |
| TD-025 | No accessibility audit (WCAG 2.1 AA) | S2 | L | UX |
| TD-026 | No light / high-contrast theme | S3 | M | UX |
| TD-027 | No Vitest / web component tests | S2 | M | Testing |
| TD-028 | Playwright single-engine (Chromium only) | S3 | XS | Testing |
| TD-029 | No Trivy / CodeQL / OWASP ZAP in CI | S2 | M | Security tooling |
| TD-030 | Pre-signed PUT content-length is signed but app trusts declared size to set the limit | S2 | S | Security |
| TD-031 | No magic-byte / MIME sniffing on uploads | S2 | M | Security |
| TD-032 | Orphaned MinIO objects when row soft-delete bypasses object delete | S2 | S | Operations |
| TD-033 | `runForTenant` uses `set_config` — correct, but app-level UUID check is the only guard against a non-UUID slip-through (documented) | S3 | — | Security defence-in-depth (already in place) |
| TD-034 | No janitor job for expired/abandoned `uploading` document rows | S3 | S | Operations |
| TD-035 | The interceptor wraps every authenticated handler in a tx, even read-only handlers | S3 | — | Performance (negligible today) |
| TD-036 | No `failed`-status object lifecycle rule in MinIO bucket | S3 | S | Operations |
| TD-037 | No password-reset flow → admins seed passwords | S2 | S | UX / Security |
| TD-038 | No tenant picker for cross-tenant email collision | S3 | S | UX |
| TD-039 | `audit_log.metadata` is jsonb with no validation — keys can drift | S3 | XS | Data quality |
| TD-040 | No coverage report | S3 | XS | Testing hygiene |
| TD-041 | No `consistent-type-imports` lint rule (intentional per ADR-0005) | S3 | — | Lint debt — accepted |
| TD-042 | Dashboard `/auth/me` panel exposes raw JSON to operators | S3 | XS | UX hygiene |
| TD-043 | Redis traffic is plaintext (no TLS) within compose / dev | S2 | S | Security (operational) |

---

## Details

### TD-001 — No rate limiting on auth endpoints · ✅ RESOLVED 2026-05-25
**Was:** online brute-force on `/auth/login` and credential-stuffing on `/auth/refresh`. The `404 + 401` discrimination is identical timing-wise (good), but unlimited request rate made username-enumeration and password-guessing economical.
**Resolution:** P0.1 added a Redis-backed fixed-window counter (INCR + EXPIRE NX in MULTI) applied to both endpoints via `RateLimitService`. Per-IP and per-email (SHA-256-hashed) counters fire in parallel; breach yields 429 + `Retry-After` + durable audit row. `app.set('trust proxy', 'loopback, linklocal, uniquelocal')` so per-IP keying remains accurate behind a future reverse proxy. OWASP-aligned defaults (30/5min IP, 5/15min email, 60/5min refresh) — env-overridable. ADR-0009 captures the design.
**Follow-on tracking:**
- Global / non-auth rate limit → P0.9 (proxy layer)
- Breach metrics → P0.7 (Prometheus)
- Per-tenant overrides → P1.4 (admin panel)

### TD-002 — No MFA
**Risk:** single-factor authentication. ToR §6.11 default is multi-factor.
**Locations:** auth flow end-to-end.
**Remediation:** TOTP first (cheapest), WebAuthn second. Backup codes one-time-use, argon2-hashed. Already on the roadmap (P1.2).

### TD-003 — No RBAC
**Risk:** every authenticated user can read every document, list every session, and (once added) act on every incident / case / workflow in their tenant. Tenant is the only access boundary.
**Locations:** `apps/api/src/modules/documents/documents.controller.ts` — `@UseGuards(JwtAuthGuard)` only.
**Remediation:** RBAC tables + `@Authorize` guard. Roadmap P1.1.

### TD-004 — No Postgres backups · ✅ RESOLVED 2026-05-25
**Was:** any disk loss was total data loss. No restore tool, no rehearsal.
**Resolution:** P0.5 added the `postgres-backup` sidecar (`infra/backup/`) — alpine + `postgresql16-client` + `mc` + busybox crond. Default schedule `0 3 * * *` UTC; dumps land in `minio/cmc-backups/postgres/YYYY/MM/cmc-<ISO-Z>.dump`; rotation drops anything older than `BACKUP_RETENTION_DAYS` (default 7). `pnpm db:backup` for one-shot manual runs; `pnpm db:restore <key|latest>` for a confirmed DROP+CREATE+`pg_restore` cycle. Restore drill rehearsed end-to-end. ADR-0012 captures the design and the deliberate gaps.
**Follow-on tracking:**
- WAL streaming / PITR → P3 (when RPO contracts below 24 h)
- Backup-success Prometheus metric → P0.7
- "No fresh backup in 36 h" Alertmanager rule → P1.8
- Dump-byte encryption via Vault → P2.14
- MinIO content backup + off-site replication → separate ops follow-ons

### TD-005 — Secrets in `.env` files
**Risk:** host compromise → secret compromise. Repo `.env.example` files use `change_me` placeholders, but the real values land on the deploy host in plain text.
**Locations:** `apps/api/.env`, `infra/.env`, CI workflow env blocks.
**Remediation:** Vault dev mode in compose, sourcing one workload's secrets first (cmc_app DB credentials are the smallest blast radius). Roadmap P2.12.

### TD-006 — No reverse proxy / TLS
**Risk:** cannot deploy externally.
**Locations:** compose has no proxy; ADR-0001 defers to "deploy step."
**Remediation:** Caddy in `infra/deploy-compose.yml` overlay. Roadmap P0.9.

### TD-007 — Unstructured logs · ✅ RESOLVED 2026-05-25
**Was:** ELK/Loki ingestion was best-effort regex. Incident debugging meant grep across processes.
**Resolution:** P0.3 swapped the NestJS default logger for `nestjs-pino`. Every `new Logger("Foo")` call site pipes through pino transparently. JSON in prod, pino-pretty in dev. Centralised redact list strips authorization / cookie / password / refreshToken. Custom req serializer trims headers to a safe allowlist. Mixin reads `RequestContextService` and `TenantContextService` ALS at log time → every line carries `requestId`, optionally `tenantId` + `userId`. ADR-0010 captures the contract.
**Follow-on:** log shipping (Loki + Promtail) → P1.7.

### TD-008 — No `request_id` / `trace_id` populated · 🟡 PARTIAL
**Was:** audit-log columns existed but were NULL; no cross-process correlation.
**Resolution (request_id only):** P0.3 added `RequestContextService` (ALS-backed) populated by `RequestContextMiddleware` that runs *before* `TenantContextMiddleware`. `AuditService.toRow()` defaults `request_id` from the ALS scope so every audit row is auto-correlated. UUID-shape gate on inbound `X-Request-Id` closes log-injection. Header echoed on response + included in problem+json body.
**Remaining:** `trace_id` still NULL — the ALS slot is reserved and the audit serializer wires through, but the OTEL plumbing that produces trace ids lands at P0.6.

### TD-009 — No metrics endpoint
**Risk:** capacity blindness.
**Locations:** absent.
**Remediation:** OTEL Prometheus exporter or `prom-client`. Roadmap P0.7.

### TD-010 — Liveness-only health check
**Risk:** Kubernetes readiness probes and load balancer health probes will route traffic to instances whose Postgres / Redis / MinIO are broken.
**Locations:** `apps/api/src/modules/health/health.controller.ts`.
**Remediation:** Add `/health/ready` and `/health/deep`. Roadmap P0.8.

### TD-011 — Audit-log hash chain absent
**Risk:** ToR §3.15 "tamper-evident" property is aspirational. A privileged operator or compromised role could rewrite history without detection.
**Locations:** `packages/db/src/schema/audit-log.ts` (columns exist), `apps/api/src/modules/audit/audit.service.ts` (writes never compute `this_hash`).
**Remediation:** per-tenant (or per-tenant-per-day) chain; SHA256 of canonical-JSON-of-row || prev_hash. Daily Merkle root anchored to MinIO Object Lock. Roadmap P1.11.

### TD-012 — Audit failures swallowed
**Risk:** an audit insert that throws (DB pressure, replication lag, network) is logged but the calling action proceeds. For compliance-mandatory actions this is the wrong direction.
**Locations:** `apps/api/src/modules/audit/audit.service.ts` lines 65–71.
**Remediation:** classify actions; for mandatory-audit actions, mark `auditRequired: true` and re-throw on failure; for everything else, log + ignore.

### TD-013 — Redis unused by app · ✅ RESOLVED 2026-05-25
**Was:** infrastructure cost without benefit; missed cache opportunities.
**Resolution:** P0.2 wired `ioredis@5` through a new `RedisModule` (`apps/api/src/modules/redis/`), registered globally, with fail-fast boot-time PING and lifecycle logging. CI runs a real Redis container. ADR-0008 captures the tier-1 dependency commitment. 4 new e2e tests; 36/36 pass.
**Follow-on tracking:** new TD-043 — TLS in transit to Redis (production deploy concern).

### TD-014 — No idempotency keys
**Risk:** mutating POSTs are not safe to retry. The pattern works today because the surface is small (auth + documents).
**Locations:** every `@Post` handler in `apps/api`.
**Remediation:** ToR §11.1 calls for `Idempotency-Key` header on all mutating endpoints. Middleware caches response by (user, idempotency-key) for a 24h window.

### TD-015 — No `/v1` URL versioning
**Risk:** no clean lever to ship a v2 in parallel; ToR §11.6.
**Locations:** controllers use `@Controller("auth")` not `@Controller("v1/auth")`.
**Remediation:** `app.setGlobalPrefix('v1')`; update web client base path; update test fixtures. Roadmap P1.9.

### TD-016 — No OpenAPI document
**Risk:** no contract to generate SDKs from; external consumers cannot self-serve.
**Locations:** `@nestjs/swagger` not a dep.
**Remediation:** add the dep + decorators + endpoint. Roadmap P1.10.

### TD-017 — `tenants` not under RLS
**Risk:** any future feature that does `SELECT * FROM tenants` from the application role would leak the full tenant directory.
**Locations:** `packages/db/migrations/0002_rls_policies.sql` — documented in the migration comment.
**Remediation:** acceptable today because the only application path queries by id/slug from validated tokens. Add RLS the moment a list path appears.

### TD-018 — Session lookup hits DB on every auth'd request · ✅ RESOLVED 2026-05-25
**Was:** at QPS this query was the dominant cost. Every authenticated request ran one Postgres SELECT for session validity.
**Resolution:** P0.4 added `SessionCacheService` (Redis-backed). The middleware checks `cmc:auth:session-active:<sid>` first; on hit + payload-match (`{userId, tenantId}`), it bypasses the DB. On miss / mismatch / cache error, falls through to the existing DB query and populates the cache on success. TTL = `SESSION_CACHE_TTL_SEC` (default 900 s, matching `JWT_ACCESS_TTL`) — failed cache DEL adds zero exposure beyond JWT expiry. Invalidation hooked into every revoke / rotate / replay-burn / expire path in `SessionsService` (now using `.returning({id})` for precise delMany). ADR-0011 captures the design.
**Follow-on:** cache hit/miss metrics → P0.7.

### TD-019 — No PgBouncer
**Risk:** ~200 concurrent users × ~20 conns per pool = pool exhaustion at the API instance.
**Locations:** absent in compose.
**Remediation:** PgBouncer container in `transaction` pooling mode. Postgres `prepare: false` in the client is already compatible.

### TD-020 — No outbox / event bus
**Risk:** cross-module reactions absent. The architecture loses the "events first-class" principle from ToR §2.3.
**Locations:** none.
**Remediation:** NATS JetStream + outbox + relay. Roadmap P2.1.

### TD-021 — Tajikistan-CMC branding hardcoded
**Risk:** the second tenant cannot be onboarded without code changes.
**Locations:**
- `apps/web/src/app/dashboard/page.tsx` (region names, ministry abbreviations, "Cabinet briefed at 03:15", "Dushanbe")
- `apps/web/src/app/login/page.tsx` (mural copy "Republic of Tajikistan's emergency operations", "National Data Center · Dushanbe", "v2.6.0 · Build 2026.05.14")
- `apps/web/src/components/cmc/sidebar.tsx` ("Crisis Management Center", "Civil Defense · TJ")
- `apps/web/src/app/layout.tsx` (metadata.description)
**Remediation:** `tenant_branding` table + a per-tenant theme provider. Roadmap P0.11.

### TD-022 — Hardcoded demo data on dashboard
**Risk:** the dashboard claims a system state that does not exist. A user sees "27 active incidents" with no underlying data.
**Locations:** `apps/web/src/app/dashboard/page.tsx` — `REGIONS`, `INCIDENT_TYPES`, `PRIORITY` arrays + the KPI strip's `value` props.
**Remediation:** replace each panel as the underlying data exists (incidents module → P1.5, dashboard rebind → P2.6).

### TD-023 — Frontend inline-styled
**Risk:** every component carries `style={{ background: "var(--c-bg-1)", border: "0.5px solid var(--c-line-2)" }}`. Adding light theme, white-label, or per-tenant theming is painful. shadcn/ui components are configured but not used.
**Locations:** `apps/web/src/components/cmc/*` and the two main pages.
**Remediation:** introduce shadcn Card/Button/Chip components; refactor existing primitives to wrap them; move all colours behind Tailwind theme tokens.

### TD-024 — No i18n
**Risk:** users in Tajikistan typically read Russian and Tajik; the UI is English-only.
**Locations:** every JSX string.
**Remediation:** `next-intl` or `react-intl`; externalise messages; expose locale-switcher.

### TD-025 — No accessibility audit
**Risk:** the inline-styled approach blocks colour-contrast tooling; no focus management beyond browser defaults; no skip links; no aria-live regions on the (future) alert ticker.
**Locations:** all `apps/web/src/**`.
**Remediation:** axe-core in Playwright; storybook accessibility add-on (once Storybook lands); WCAG 2.1 AA contrast check on the dark palette.

### TD-026 — No light/high-contrast theme
**Risk:** ToR §12.2 calls for three themes; today `<html className="dark">` is forced.
**Remediation:** with shadcn HSL tokens it is a matter of CSS variable sets and a `useTheme` hook.

### TD-027 — No Vitest / web component tests
**Risk:** the only web testing is Playwright. Component-level regressions (a misbehaving form, a bad chart axis) only get caught when the e2e flow visits the page.
**Remediation:** Vitest + Testing Library for components. ADR-0007 §"known gaps."

### TD-028 — Playwright Chromium-only
**Risk:** WebKit / Firefox-specific cookie or CSS bugs invisible.
**Remediation:** one-line config change in `playwright.config.ts`; ADR-0007.

### TD-029 — No SAST / dependency / container scanning
**Risk:** ToR §13.14 calls for Semgrep, CodeQL, Trivy, OWASP Dependency-Check, OSV-Scanner, Falco, ZAP.
**Locations:** absent from `.github/workflows/ci.yml`.
**Remediation:** start with Trivy + osv-scanner + Semgrep — all open source, all free for self-hosted.

### TD-030 — Trusting declared `sizeBytes` for the upload limit
**Risk:** the pre-signed PUT carries the declared `Content-Length` in the signature (good — S3 enforces it). But a client that lies about size at upload-init can request a high-but-still-valid presign URL and upload that much; the size check at finalize fails after the bytes are already in MinIO.
**Locations:** `documents.service.ts:46-50` + `storage.service.ts:60-67`.
**Remediation:** bucket-level size policy + lifecycle to delete `failed`-status objects + tighter per-tenant per-day upload quota.

### TD-031 — No MIME sniffing
**Risk:** the uploader-declared MIME is trusted. A `.exe` claiming `image/png` is accepted.
**Locations:** `documents.controller.ts` validates IANA shape but not content.
**Remediation:** add a finalize-side check using `file-type` (or `mmmagic`) reading the first 4 KB of the object via a range GET. Reject on mismatch.

### TD-032 — Orphaned MinIO objects on partial soft-delete
**Risk:** if `storage.delete()` fails after the row is soft-deleted, bytes linger in the bucket.
**Locations:** `documents.service.ts` `softDelete()`.
**Remediation:** nightly janitor that reconciles `deleted_at IS NOT NULL` rows with the bucket (ADR-0004 named this).

### TD-033 — UUID check on `runForTenant` is application-level
The `set_config` parameter is bind-bound so injection is closed. The UUID regex is a belt-and-suspenders second guard, **already present**. Listed for completeness — no action.

### TD-034 — No janitor for `uploading` rows
**Risk:** a failed upload leaves a row in `uploading` forever; takes a slot in the user's list view (the list filters by `status = 'ready'`, so this is purely a row-bloat concern); the per-tenant quota counting (when it lands) would over-count.
**Remediation:** cron sweep that flips `uploading` rows older than 24 h to `failed`.

### TD-035 — Transaction on every authenticated handler
**Cost:** ms-level. **Risk:** a slow handler holds a connection. Negligible today.
**Remediation:** no action; document.

### TD-036 — No bucket lifecycle for `failed`-status objects
**Remediation:** MinIO lifecycle rule that auto-deletes objects whose key matches a `failed` pattern after 24 h. ADR-0004 named this.

### TD-037 — No password reset flow
**Risk:** admins set passwords via seed/SQL; users have no recovery path.
**Remediation:** Roadmap P1.3.

### TD-038 — No tenant picker for ambiguous emails
**Risk:** when one email belongs to two tenants, login fails with the same 401 as wrong-password. Bad UX, but currently no second tenant exists.
**Locations:** `auth.service.ts:68-72`.
**Remediation:** when `candidates.length > 1`, return a `tenant_picker_required` outcome with the list of tenant slugs (over a redirect-aware POST). Roadmap H1.

### TD-039 — `audit_log.metadata` keys drift
**Risk:** every audit consumer (SIEM forwarder, future dashboards) must accommodate every key that ever existed. Keys are added per call site with no central registry.
**Remediation:** a small `AuditMetadata` zod schema enumerating well-known kinds (login-failure-reason, file-finalize-mismatch, etc.).

### TD-040 — No coverage report
**Risk:** unknown blind spots in the test suite.
**Remediation:** `jest --collectCoverage` in a separate CI job (ADR-0006 deferred this).

### TD-041 — `consistent-type-imports` rule disabled
ADR-0005 explains this is a deliberate accommodation of NestJS DI. **No action.**

### TD-042 — Dashboard exposes raw `/auth/me` JSON
**Risk:** UX hygiene; for an operator, "Session · /auth/me" with a raw JSON dump is incongruous with the rest of the dashboard.
**Remediation:** turn into a debug-mode-only widget once the dashboard renders real data (TD-022).

### TD-043 — Redis traffic is plaintext within compose / dev
**Risk:** Redis password is sent over a plaintext TCP connection between the API container and the Redis container. Inside a single docker host this is contained, but the moment Redis lives on a different host (multi-host docker, Sentinel cluster, managed Redis) the password and all cached data become snoopable on the wire.
**Locations:** `REDIS_URL=redis://...` in `apps/api/.env.example` + `infra/docker-compose.yml` Redis service (no `--tls-port`).
**Remediation:** for any non-single-host deployment, use `rediss://` and configure Redis with TLS certificates (either via Caddy/proxy termination or Redis's own `--tls-*` flags). For dev / CI, plaintext on the docker network is acceptable. Captured in ADR-0008.

---

## Aggregate

- **Resolved since audit baseline:** 5 (TD-013 by P0.2; TD-001 by P0.1; TD-007 by P0.3; TD-018 by P0.4; TD-004 by P0.5)
- **Partial:** 1 (TD-008 — request_id ✅ via P0.3; trace_id awaits P0.6)
- **S0 items (must-fix before any non-dev deploy):** 4 (was 5; TD-004 resolved).
- **S1 items (correctness/security under realistic load):** 4.
- **S2 items (operational pain / scale cap):** 16 (was 17; TD-018 resolved).
- **S3 items (hygiene):** 13.

Many S0 / S1 items are **already named in ADRs as known gaps**. The ADR discipline functions as a debt register — this document is the consolidated form.

## Tracking

- Treat **every S0 + S1 as a hard gate** on the corresponding roadmap horizon exit.
- Allocate **one engineering thread per sprint** to S2 items once roadmap items are flowing.
- S3 items batch into a "polish sprint" each quarter.

Cross-reference each row in this register against the matching entry in [`PRIORITY_EXECUTION_PLAN.md`](./PRIORITY_EXECUTION_PLAN.md).
