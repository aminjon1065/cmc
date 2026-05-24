# SYSTEM AUDIT
## Unified Enterprise Operational Intelligence Platform (CMC)

**Audit date:** 2026-05-24
**Audit perspective:** Principal Architect / Enterprise Solution Architect / Staff Engineer
**Scope:** Full repository against [ToR.md](../ToR.md) (v1.0) and ADRs 0001–0007
**Branch / version:** `main` @ commit `45d100e` (tag `0.0.1`)
**Audit verdict:** **Pre-MVP foundation. Excellent substrate quality, ~5 % of ToR feature surface delivered.**

---

## 0. Executive verdict

The repository is a **deliberately small, deliberately correct foundation** for a system whose ToR describes a national-scale, 7-ring, multi-product platform (BI + GIS + ECM + Chat + Video + Workflow + AI). That mismatch is the single most important fact in this audit — and it is **acknowledged** in [ADR-0001](../adr/0001-initial-architecture-and-stack.md) (solo developer, Docker Compose target, "full ToR scope remains the long-term target").

Reading the code with that lens, the substrate quality is **unusually high**:

- Tenant isolation is **structurally enforced** at the Postgres layer (RLS + role split + GUC bypass + `FORCE ROW LEVEL SECURITY` + regression tests). Most "multi-tenant SaaS MVPs" reach production with this still broken.
- Auth has **server-side sessions, refresh-token rotation with replay detection (family burn), audit on every outcome, argon2id with timing protection** — equivalent in shape to ToR §6.10 / §6.11 minus MFA.
- Documents module exercises the **production upload pattern** (pre-signed direct-to-S3, finalize verifying ETag + size, idempotent finalize, soft-delete, autonomous-transaction failure markers).
- CI runs the migration chain, role-flag assertions, full API e2e (32 tests) and real-browser Playwright suite on every push.
- Every persisted row carries `tenant_id`. Every shared schema is `zod`-validated on both sides of the wire. Every audit-relevant action is recorded with durable failure-path persistence.

That is the **strict positive** half of the audit.

The **strict negative** half is that **22 of the 27 ToR §3 modules are NOT STARTED**, and the modules that exist are sitting on infrastructure that explicitly does not yet include NATS, ClickHouse, OpenSearch, Qdrant, PgBouncer, Patroni, Vault, Kubernetes, Argo CD, OPA, Temporal, LiveKit, OpenTelemetry, Prometheus, Loki, Tempo, Grafana, MapLibre, pg_tileserv, Yjs, BullMQ, Kong, Caddy, or coturn. The roadmap explicitly defers these. **That is a choice, not an oversight** — but it bounds what "production-ready" can mean today.

**Honest summary:**
- **MVP-ready?** Yes, for an internal pilot in one tenant doing nothing but documents.
- **Beta-ready?** No. Missing: rate limiting, MFA, GIS, dashboards-from-data, events.
- **Production for the ToR's named customers (ministries, central banks, critical infra)?** No, by an order of magnitude in module coverage and two orders of magnitude in operational readiness (HA, DR, observability, compliance evidence).
- **Architecturally sound for incremental growth to the ToR vision?** Yes — the module boundaries, contract package, RLS scaffold, idempotency discipline, and audit-from-day-one give every future module a clean template.

The rest of this document quantifies, justifies, and prioritises that picture.

---

## 1. Architecture

### 1.1 Topology

```
+--------------------------+         +------------------------------------+
|   apps/web (Next.js 15)  |  HTTPS  |   apps/api (NestJS 10 monolith)   |
|   App Router · RSC       +-------->|                                    |
|   BFF via Server Actions |   JWT   |   modules/                         |
|   Auth.js v5 (JWT sess)  | bearer  |     auth · tenants · users         |
+-----------+--------------+         |     documents · storage · audit    |
            ^                        |     health · database              |
            |                        +---------------+--------------------+
            | RLS-bound Postgres     +---------------|--------------------+
            |  (cmc_app role)        v                                    v
+-----------+--------------+   +------------+   +--------+   +-----------------+
|     Postgres 16          |   |   MinIO    |   | Redis  |   | (NATS, CH, OS,  |
|  PostGIS + pgvector      |   |    S3      |   |  7     |   |  Qdrant, Temp.) |
|  RLS on every tbl        |   +------------+   +--------+   |  NOT STARTED    |
+--------------------------+                                  +-----------------+
```

### 1.2 DDD / module boundaries — actual

`apps/api/src/modules/` holds eight modules. Boundaries are clean:
- Cross-module calls go through injected services, not shared tables.
- The only **cross-module FKs** are `users.tenant_id → tenants`, `sessions.user_id → users`, `documents.uploaded_by → users`. All four are within the same logical bounded context (identity / scope), and the ToR §2.4 rule ("no foreign keys across module boundaries") is observed for the actual product modules (Documents references users only by id-with-FK, but does not query the users table directly).
- `TenantContextService` (ALS) is the only cross-cutting state primitive — clean, justifiable, scoped.

**Compliance with ToR §2.3 principles:**

| Principle | Current state |
|---|---|
| Event-first | ❌ Not started. No outbox table, no broker. Mutations don't emit events. |
| Tenant-first | ✅ Structural via RLS + middleware + interceptor. |
| Identity-anchored | ⚠ Internal service-to-service identity not yet a problem (single process). JWT used at the edge. |
| Read/write separation | ❌ Single Postgres for everything. ClickHouse / OpenSearch / Vector DB deferred. |
| Idempotent by default | ⚠ Finalize is idempotent; other mutations have no idempotency keys yet. No `Idempotency-Key` header support. |
| Schema-explicit | ✅ Zod contracts cover every API surface, used on both sides. |
| Observable by construction | ❌ No metrics, no traces, structured logs only via NestJS default logger. |
| Failure-isolated | ⚠ Single-process; no circuit breakers; no bulkheads. Acceptable at current scope, called out in ADR-0001. |

### 1.3 Coupling / cohesion

- No circular deps; package graph is `contracts` ← `db` ← `api` / `web`.
- The `TenantTransactionInterceptor` global → all controllers depend implicitly on `DatabaseModule`. This is the right call (RLS is platform-wide); it's not a coupling smell.
- `AuthService.dummyVerify()` lives inside `auth.service.ts` instead of a `crypto.ts` utility — fine at one call site.

### 1.4 Distributed-systems readiness

| Concept | Status |
|---|---|
| Outbox pattern | ❌ Audit log is closest analogue but not used as outbox. |
| Idempotent consumers | N/A — no consumers exist. |
| Saga / compensation | N/A. |
| Circuit breaker | ❌. |
| Bulkhead | ❌. |
| Timeouts on external calls | ⚠ MinIO calls inherit AWS SDK defaults (30s). No explicit per-call budgets. |
| Backpressure | ❌. |
| W3C trace context propagation | ❌. |
| `processed_events` dedup table | ❌. |

**Verdict:** Architecturally the codebase is a **modular monolith with first-class tenant isolation**, which is the explicit Phase-1 posture in ToR §2.1 and ADR-0001. There is **no distributed-systems plumbing yet** and that is deliberate.

---

## 2. Backend (apps/api)

### 2.1 Inventory

| Module | Files | Responsibility | Maturity |
|---|---|---|---|
| `health` | 1 | Liveness only (no DB/Redis/S3 probes) | 🟡 Surface OK, depth shallow |
| `database` | 4 | Drizzle client + RLS-aware tx interceptor + tenant DB service + tokens | 🟢 Production-grade |
| `tenant-context` (common) | 3 | ALS-backed context, JWT verification middleware | 🟢 Production-grade |
| `auth` | 5 | Login, refresh rotation w/ replay detect, logout, session list/revoke | 🟢 Production-grade for the surface it covers |
| `tenants` | 2 | Lookup by id/slug — no admin CRUD | 🟡 Minimum viable |
| `users` | 2 | Tenant-scoped + global lookup, mark login — no CRUD, no roles, no groups | 🔴 Stub |
| `audit` | 2 | Append-only, durable-on-demand | 🟢 Solid; missing hash chain, outbox, projection |
| `storage` | 3 | S3 dual-client (internal/public), HEAD/DELETE/presignPUT/GET | 🟢 Production-grade for S3 |
| `documents` | 3 | Init / finalize / list / get / signDownload / softDelete | 🟢 Solid first domain module |

### 2.2 Strengths

1. **RLS scaffold is the best part of this codebase.** Three interlocking pieces:
   - `TenantContextMiddleware` validates JWT + verifies session is active (no-stale-token).
   - `TenantTransactionInterceptor` wraps every authenticated handler in `tenantDb.runForTenant(...)` which `SET LOCAL app.tenant_id` via `set_config()` (parameterised — closed to injection).
   - `TenantDatabaseService.runPrivileged()` is the **only** RLS-bypass path; uses `try/finally` to reset the GUC, guards against the well-known SET-LOCAL-into-savepoint footgun.
   The runtime role `cmc_app` is `NOSUPERUSER NOBYPASSRLS`, and `FORCE ROW LEVEL SECURITY` is on every tenant-scoped table. **Reg-tested** in `rls.e2e-spec.ts`.

2. **Refresh-token rotation is correctly implemented.**
   - Single-use refresh, SHA-256 hashed at rest, 48-byte random `base64url`.
   - On replay (presented refresh points at already-revoked row): **entire `family_id` burned via autonomous `runPrivileged` transaction** so the burn survives the controller's 401 rollback. This is the kind of detail that fails silently in 90 % of MVP auth implementations.
   - Web-side de-duplication of in-flight refresh via `Map<refreshToken, Promise>` in [auth.ts:41](../../apps/web/src/auth.ts) prevents the parallel-RSC race that would otherwise look like theft to the API.

3. **Argon2id with constant-time dummy-verify on the no-user code path.** OWASP-2023 parameters. Login timing does not leak account existence.

4. **Audit is durable on failure paths.** `AuditService.record({ durable: true })` writes through `runPrivileged` so 401 rollbacks don't drop the audit evidence. This is the correct asymmetry — success-path audit is atomic with the action; failure-path audit outlives it.

5. **Documents finalize cross-checks size AND ETag** against the S3 HEAD response; on mismatch marks the row `failed` via autonomous tx (same pattern as the family burn). Re-finalize is idempotent.

6. **DTOs use class-validator with `forbidNonWhitelisted: true` + global `ValidationPipe`.** No silent extra-field acceptance.

7. **Global `HttpExceptionFilter` returns RFC-7807 `application/problem+json`.** Unhandled errors logged with stack but never leak internals to the client.

### 2.3 Weaknesses / risks

1. **No RBAC / ABAC.** Every authenticated user can perform every action. The ToR §3.3 model (RBAC + OPA-evaluated Rego policies) is entirely absent. There are no `roles` / `permissions` / `policies` tables, no `@AuthorizeWith(...)` decorator, no PDP/PEP/PIP.

2. **No rate limiting on auth endpoints.** `POST /auth/login` and `POST /auth/refresh` will brute-force on a public deployment. Called out in ADR-0003 §"known gaps" but not yet implemented.

3. **No MFA (TOTP / WebAuthn).** Called out in ADR-0002/0003.

4. **Audit-log hash chain missing.** Columns exist (`prev_event_hash`, `this_hash`) but no service code populates them. ToR §3.15 "tamper-evident chain" is therefore aspirational.

5. **`tenants` table has no RLS.** Documented in `0002_rls_policies.sql` ("source of tenant identity, queried before context exists"). Correct rationale today; **the moment a feature lists tenants for a user, RLS is required**.

6. **`audit_log` write failures are swallowed.** [audit.service.ts:65-71](../../apps/api/src/modules/audit/audit.service.ts). Logged but the calling action proceeds. ToR §3.15 ("comprehensive") implies audit-mandatory ops should refuse on audit failure — current code is best-effort.

7. **No `Idempotency-Key` header support on mutating endpoints.** Mostly hidden because Documents has idempotent finalize; the moment we add Cases / Workflows it becomes a per-endpoint chore.

8. **WebSocket gateway: none.** Required by ToR §3.6, §3.11, §3.22, §7.

9. **Event publishing: none.** No outbox table, no relay process, no NATS/Kafka.

10. **No worker / queue infrastructure.** Background jobs (session sweep, orphan-object janitor, preview generation, embedding pipeline) all rely on "future iteration."

11. **Health check is single-tier.** Returns `{status: "ok"}` without probing Postgres / Redis / MinIO. ToR §14.8 requires deep readiness.

12. **No tracing.** No `trace_id` / `request_id` / `correlation_id` propagation. The `audit_log` schema has columns for them but nothing populates them.

13. **`request.userAgent` truncation:** column is `varchar(512)`. Real user-agent strings rarely exceed but defensive trimming would be nice.

### 2.4 Transaction management

The interceptor wraps **every authenticated request** in one transaction. This is correct for OLTP isolation but has consequences:

- **Long-running handlers hold the connection.** No handler currently exceeds ms-range, but file-processing or external-API-calling handlers will block a pool slot.
- **Read endpoints that don't need a tx pay for one.** Acceptable for tenant safety; performance impact negligible at current load.
- **The rxjs Observable → Promise bridge in [tenant-transaction.interceptor.ts:39-47](../../apps/api/src/modules/database/tenant-transaction.interceptor.ts)** is correct (`collected.push(v)`, `complete: resolve`) but subtle. Any controller that returns a multi-emission Observable (none today) would have its emissions reordered into one resolution.

### 2.5 Auth flow — end-to-end

```
Browser              Web (Next.js)            API (NestJS)            Postgres
   |                      |                         |                    |
   |  POST /login form    |                         |                    |
   |--------------------->|  Auth.js Credentials    |                    |
   |                      |  provider.authorize     |                    |
   |                      |  fetch /auth/login ---->| privTx (bypass RLS) |
   |                      |                         | user lookup ---->|->|
   |                      |                         | argon2 verify       |
   |                      |                         | session insert      |
   |                      |                         | audit insert       |
   |                      |                         |<-- token bundle    |
   |                      |                         |                    |
   |                      |  Auth.js wraps API JWT  |                    |
   |                      |  in encrypted cookie    |                    |
   |  Set-Cookie ...      |                         |                    |
   |<---------------------|                         |                    |
   |                      |                         |                    |
   |  GET /dashboard      |                         |                    |
   |--------------------->|  RSC: authedApiFetch    |                    |
   |                      |  Authorization: Bearer  |                    |
   |                      |  fetch /auth/me ------->| middleware verify  |
   |                      |                         | + session lookup  ->|
   |                      |                         | → tenant tx       |
   |                      |                         |<-- 200 user data   |
```

Refresh dance runs in the `jwt` callback transparently; in-flight dedup prevents replay false-positives.

**Open holes:** no CSRF protection on cookie-borne calls (not needed today because the bearer pattern doesn't rely on cookies for the API; relevant the moment we add a same-origin cookie-auth surface for non-API routes); no DPoP / token binding.

---

## 3. Frontend (apps/web)

### 3.1 Inventory

| Surface | Files | Status |
|---|---|---|
| Root layout, fonts (Geist/Onest/JetBrains_Mono) | `app/layout.tsx` | ✅ |
| Login page (split-screen w/ TJ Civil Defense branding) | `app/login/page.tsx` + `components/login-form.tsx` | ✅ |
| Dashboard page (KPIs, demo data, real `/auth/me` panel) | `app/dashboard/page.tsx` | ⚠ Mostly mocked |
| Documents list + upload + delete | `app/documents/*.tsx` + `actions.ts` | ✅ |
| Auth.js v5 (Credentials, JWT session, refresh dance, signOut event) | `auth.ts` | ✅ |
| Auth.js route handler | `app/api/auth/[...nextauth]/route.ts` | ✅ |
| Edge middleware (protect `/dashboard`, `/documents`; bounce auth'd from `/login`; respect `?next=`) | `middleware.ts` | ✅ |
| BFF utilities (`apiFetch`, `authedApiFetch` w/ Headers-spread bug fixed; 204 handling) | `lib/api.ts`, `lib/server-api.ts` | ✅ |
| Design-system components (AppShell, Sidebar, Topbar, KPI, PercentBar, Emblem, sign-out) | `components/cmc/*` | ⚠ Inline-styled, no Storybook, no token export |
| Sidebar navigation referencing 21 future modules — all but Dashboard + Documents disabled | `components/cmc/sidebar.tsx` | ✅ Honest "Coming soon" |

### 3.2 Strengths

1. **Real Server Components doing real BFF.** `dashboard/page.tsx` and `documents/page.tsx` are server components calling `authedApiFetch` → API. The Auth.js encrypted session cookie wraps the API JWT so it never leaks to the browser JS context.

2. **Server Actions for mutations** ([documents/actions.ts](../../apps/web/src/app/documents/actions.ts)). `revalidatePath('/documents')` after delete / finalize keeps the list consistent without client-side state libraries.

3. **Zod schemas from `@cmc/contracts` validate every API response** before rendering. Contract drift fails loudly, not silently.

4. **`apiFetch` Headers fix is real engineering.** The `{ ...new Headers(...) }` spread-drop bug (documented in ADR-0007) is the kind of thing that ships to production silently — caught by the browser-level Playwright suite. Confidence in the API client is now load-bearing on tests, not on developer memory.

5. **204 handling.** `apiFetch` short-circuits empty bodies so `DELETE` doesn't throw `SyntaxError`.

6. **Upload form uses XHR for progress** because `fetch` body-upload progress isn't broadly available. Three-phase state machine (init → presigned PUT → finalize) reflects the actual lifecycle.

7. **Edge middleware compositional `?next=` with `?reason=RefreshFailed`.** Real session-recovery UX, not a generic 401.

### 3.3 Weaknesses

1. **Inline CSS-in-JSX everywhere.** Every component sets `style={{ background: "var(--c-bg-1)", borderBottom: "0.5px solid var(--c-line-2)" }}`. This is a design-system-in-progress, not a fully-realised one. shadcn HSL tokens are mapped in `globals.css` but components don't use shadcn `<Card>`, `<Button>`, etc. — the `components.json` exists but the components don't.

2. **Tailwind config + class-variance-authority + tailwind-merge installed but barely used.** A real design system would expose `<Card>`, `<KPI>`, `<Chip>`, `<Badge>` with `cva` variants. Today it's hand-styled cards.

3. **No Storybook.** ToR §12.2 calls for it.

4. **No light theme.** `<html className="dark">` is forced. Per-tenant white-label theming (ToR §12.2) absent.

5. **No i18n.** Russian/Tajik users are the obvious target (per the login mural and dashboard region names: Khatlon, GBAO, Sughd, DRS, Dushanbe). Hardcoded English strings throughout.

6. **No accessibility audit.** ToR §12.10 calls for WCAG 2.1 AA. Inline `style={{}}` makes color-contrast and theme-toggle audit harder. No skip links, no focus-visible polish beyond browser defaults.

7. **No client-state library.** Zustand, TanStack Query — none. Acceptable because the only mutation surfaces are documents and auth, both via Server Actions. Re-evaluate at the dashboard-builder / chat / GIS step.

8. **Command palette (ToR §12.6): not started.**

9. **Performance budgets (ToR §12.13): unverified.** No Lighthouse CI, no bundle analyser in pipeline.

10. **The dashboard page hardcodes Tajikistan-specific content** (regions, Cabinet briefing language). This is intentional product personality, **but** means the codebase is now implicitly the Crisis Management Center for Tajikistan's Committee of Emergency Situations and Civil Defense — call out below in §11.

---

## 4. Database

### 4.1 Schema

5 tables, all under RLS-via-GUC except `tenants`:

| Table | Rows of business meaning | RLS |
|---|---|---|
| `tenants` | Source of tenant identity | ❌ deliberate (documented) |
| `users` | Per-tenant accounts, argon2 hash, last login | ✅ FORCE |
| `sessions` | Refresh-token family chain, IP, UA, expiry, revoke | ✅ FORCE |
| `audit_log` | Append-only events (insert permissive, select scoped, update/delete only via bypass) | ✅ FORCE |
| `documents` | Tenant-scoped file metadata, soft-delete | ✅ FORCE |

### 4.2 Indexes

Well-chosen for current query patterns:
- `users(tenant_id, email)` unique — supports the per-tenant email uniqueness invariant.
- `documents(tenant_id, created_at)` — covers the list query's order-by.
- `documents(tenant_id, status)` — supports filtering pending uploads / janitor jobs.
- `sessions(family_id)` — supports family-burn UPDATE.
- `sessions(user_id, revoked_at)` — supports "list my active sessions."
- `audit_log(tenant_id, occurred_at)` — supports the canonical "audit feed for tenant X" query.

**Missing:**
- No GIN on `documents(tsvector)` — ILIKE search (with escaped wildcards) is a sequential scan inside the tenant. Acceptable up to ~10⁴ documents per tenant.
- No partial indexes (`WHERE status = 'ready'` would be more selective on a tenant with many uploads).
- No BRIN on `audit_log(occurred_at)` — append-only is the textbook BRIN case.

### 4.3 Migrations

Five migrations:
- `0000_initial.sql` — tenants, users, audit_log
- `0001_sessions.sql` — sessions
- `0002_rls_policies.sql` — RLS via GUCs on users/sessions/audit_log
- `0003_documents.sql` — documents table
- `0004_documents_rls.sql` — RLS on documents

All Drizzle-generated except the RLS migrations (hand-written, idiomatic Postgres). Migrations are **CI-tested** (apply cleanly, policies + roles end up in the expected state).

### 4.4 Extensions enabled (from `01-extensions.sql`)

PostGIS, postgis_topology, vector, pg_trgm, btree_gin, ltree, pgcrypto, btree_gist — **all the substrate** for GIS, embeddings, fuzzy search, hierarchical file paths, time-series-friendly indexing. **None of these extensions are used by any schema yet** — they exist so the first module that needs them doesn't require a coordinated extension-installation step.

### 4.5 PostGIS / spatial readiness

Extensions installed. **Zero geometry columns, zero spatial indexes, zero spatial queries.** Per ToR §4 the GIS module is a whole product surface; this codebase has not touched it.

### 4.6 pgvector / embeddings readiness

Extension installed. **No vector columns, no embedding pipeline, no kNN queries.** Per ToR §16.3.

### 4.7 Multi-tenancy strategy

**Shared schema with RLS** per ToR §3.2's preferred default. **No per-tenant schema option, no per-tenant DB option.** Migration tooling for "graduate a tenant to dedicated infrastructure" (ToR §3.2 last paragraph) does not exist.

### 4.8 Connection pooling

App-level via `postgres` library (`max: 20`). **No PgBouncer.** Acceptable at 20 connections per API instance × 1 instance = 20 total. Beyond ~200 concurrent users, PgBouncer in transaction-pooling mode becomes mandatory.

### 4.9 Backup / recovery

**None configured.** No `pg_dump` cron, no WAL archiving, no Patroni, no replication. ToR §13.6 / §13.7 unimplemented.

---

## 5. Infrastructure

### 5.1 What exists

`infra/docker-compose.yml` runs 4 services + 1 init container:
- `postgres` — custom image (PostGIS 3.4 + pgvector), 200 max connections, 512 MB shared_buffers, statement-log threshold 500 ms, init scripts mounted read-only.
- `redis` — Redis 7, password-protected, AOF persistence, `allkeys-lru` eviction. **Currently unused by application code.**
- `minio` — S3-compatible object storage, single node.
- `minio-init` — one-shot bucket creation via `mc`.

No reverse proxy in compose (Caddy mentioned in ADR-0001 as an add-at-deploy step). No Prometheus, Grafana, Loki, Tempo, OTEL collector, NATS, ClickHouse, OpenSearch, Qdrant, LiveKit, coturn, Temporal, n8n.

### 5.2 What's missing relative to ToR §13

| ToR requirement | Status |
|---|---|
| Kubernetes | ❌ Compose only (acknowledged in ADR-0001) |
| Service mesh (Istio/Linkerd) | ❌ |
| Argo CD / GitOps | ❌ |
| HPA / VPA / KEDA | ❌ |
| TLS via cert-manager | ❌ (Caddy at deploy time) |
| Backups (pgBackRest / wal-g) | ❌ |
| Monitoring (Prometheus + Thanos) | ❌ |
| Logs (Loki) | ❌ |
| Traces (Tempo/Jaeger) | ❌ |
| SIEM forwarder (Vector/Fluent Bit) | ❌ |
| WAF | ❌ |
| Secrets manager (Vault) | ❌ — secrets in `.env` files |
| Image scanning (Trivy) | ❌ |
| SBOM | ❌ |
| Network policies | N/A (single host) |

### 5.3 Secrets handling

`apps/api/.env.example`, `infra/.env.example` carry placeholders like `cmc_dev_password_change_me`. ToR §6.9 requires Vault with dynamic secrets — not started. Acceptable for solo-dev; **must** be addressed before any non-dev deployment.

### 5.4 Deployment story

Implicit: `pnpm build` → `node apps/api/dist/main.js` and `pnpm --filter @cmc/web start` behind a reverse proxy. No Dockerfile for the apps themselves yet (only for Postgres). No release workflow. No blue-green / canary.

---

## 6. Security posture

(See dedicated [SECURITY_REVIEW.md](./SECURITY_REVIEW.md) for the full review. Summary here.)

| Control | ToR ref | Status |
|---|---|---|
| Password hashing (argon2id, per-tenant pepper) | §3.1, §6.10 | 🟢 argon2id ✓ · ❌ no pepper |
| MFA (TOTP + WebAuthn) | §6.11 | ❌ |
| Session lifecycle + revoke | §6.10 | 🟢 |
| Refresh rotation + replay detect | §6.10 | 🟢 |
| RBAC | §6.1 | ❌ |
| ABAC / OPA | §6.2 | ❌ |
| Tenant isolation (RLS) | §6.3, §6.4 | 🟢 structural |
| Per-tenant DEK / envelope encryption | §6.3 | ❌ |
| Encryption at rest (DB, files) | §6.7 | ⚠ application-level off · storage-level depends on deployment |
| Encryption in transit (TLS 1.3, mTLS) | §6.8 | ⚠ depends on deploy reverse-proxy; no mTLS |
| Secrets in Vault | §6.9 | ❌ |
| Rate limiting | §3.1, §11.8 | ❌ |
| Audit trail | §3.15 | 🟢 functional · ❌ hash chain · ❌ Merkle anchor |
| Immutable WORM storage | §6.6 | ❌ |
| DLP | §6.14 | ❌ |
| SIEM export | §6.15 | ❌ |
| Zero-trust / mTLS service mesh | §6.16 | ❌ |

---

## 7. Realtime & events

(See [SCALABILITY_REVIEW.md](./SCALABILITY_REVIEW.md) for capacity reasoning.)

| Capability | ToR | Status |
|---|---|---|
| WebSocket gateway | §3.6, §7.1 | ❌ |
| Pub/Sub broker (NATS JetStream) | §3.6 | ❌ |
| Outbox pattern | §3.6 | ❌ |
| Idempotent consumers | §3.6 | N/A |
| Presence system | §7.3 | ❌ |
| Live event streams | §7.4 | ❌ |
| Optimistic updates | §7.5 | ❌ (no realtime channel) |
| CRDT (Yjs) collab | §3.22 | ❌ |

**None of the realtime plane exists.** This is Phase-2/4 work in the ToR roadmap.

---

## 8. GIS

| Capability | ToR | Status |
|---|---|---|
| PostGIS extension | §4 | ✅ installed |
| Spatial schema (features, layers) | §4.8 | ❌ |
| Vector tile server (pg_tileserv) | §4.2 | ❌ |
| Frontend MapLibre GL | §4.2 | ❌ |
| Geofencing | §4.7 | ❌ |
| Realtime tracking | §4.11 | ❌ |
| Spatial analytics | §4.13 | ❌ |
| Heatmaps / clustering | §4.14, §4.15 | ❌ |
| Coordinate-system handling | §4.16 | ❌ |
| Tile caching layers | §4.18 | ❌ |

**GIS is 0 % implemented.** The PostGIS image and extension installation is the only readiness. This is Phase-2 in the ToR.

---

## 9. Workflow / BPM

| Capability | ToR §10 | Status |
|---|---|---|
| Temporal integration | §10.1 | ❌ |
| Approvals | §10.2 | ❌ |
| Automations | §10.3 | ❌ |
| State machines | §10.5 | ❌ |
| SLA tracking | §10.7 | ❌ |
| Escalation | §10.8 | ❌ |
| Visual builder | §10.9 | ❌ |

**Zero workflow infrastructure.** Phase-3.

---

## 10. AI readiness

| Capability | ToR §16 | Status |
|---|---|---|
| pgvector extension | §16.4 | ✅ |
| Embedding pipeline | §16.3 | ❌ |
| LLM gateway (vLLM / Ollama / TGI) | §16.8 | ❌ |
| RAG framework | §16.9 | ❌ |
| Document intelligence (OCR, classification) | §16.5, §16.6 | ❌ |
| Semantic search | §16.3 | ❌ |
| AI audit / safety | §16.11 | ❌ |

**Only the extension is in place.** Phase-5.

---

## 11. Observability

(See [OBSERVABILITY_REVIEW.md](./OBSERVABILITY_REVIEW.md) for detail.)

| Control | ToR §14 | Status |
|---|---|---|
| OpenTelemetry SDK in services | §13.11 | ❌ |
| Prometheus metrics | §14.1 | ❌ |
| Loki structured logs | §13.10 | ⚠ NestJS Logger → stdout, JSON not enforced |
| Tempo/Jaeger traces | §13.11 | ❌ |
| Grafana dashboards | §14.7 | ❌ |
| Alertmanager → on-call | §14.4 | ❌ |
| Audit-log SIEM tail | §14.5, §14.6 | ❌ |
| Health probes (live/ready/startup/deep) | §14.8 | 🟡 liveness only |

---

## 12. Testing & CI

| Layer | Status |
|---|---|
| API unit tests | 0 (deliberate per ADR-0006 §1) |
| API e2e integration | 32 tests, 4 specs (auth, rls, documents, health), serial against `cmc_test` |
| Web e2e (Playwright) | 11 tests, 2 specs (auth, documents), chromium-only |
| Visual regression | ❌ |
| Load / soak | ❌ |
| Mutation / property-based | ❌ |
| CodeQL / SAST | ❌ |
| Trivy / Grype container scan | ❌ |
| DAST (OWASP ZAP) | ❌ |
| Test coverage reporting | ❌ deliberate |
| Performance budgets in CI | ❌ |

**CI pipeline** (`.github/workflows/ci.yml`): two parallel jobs — `verify` (format + lint + typecheck + build) and `integration` (build Postgres image, start container, MinIO, migrate, seed, run Jest e2e, run Playwright e2e, upload report on failure). Concurrency-cancels in-flight runs on the same branch. Dependabot weekly grouped PRs.

This is **better CI than most enterprise greenfield repos at the same maturity stage.** Real CI catches were already documented in ADR-0007 (Headers spread-drop, 204 JSON parse).

---

## 13. Project identity — TJ Crisis Management Center

The UI and `README.md` describe a generic platform, but the dashboard hardcodes:
- "Crisis Management Center · Civil Defense · TJ"
- Region names: Khatlon, GBAO, Sughd, DRS, Dushanbe
- Tajikistan-specific seismology source ("IGS Shahriston M4.2"), ministry abbreviations (MNS, DOR)
- "National Data Center · Dushanbe"
- Login mural "Sovereign-grade crisis intelligence for the Republic of Tajikistan's emergency operations"

**This is not in the ToR.** The ToR describes a generic horizontal platform; the code embeds a specific vertical (national emergency management for one country).

**Implication for the audit:**
- The product roadmap implicit in the UI is **narrower and more urgent** than the ToR roadmap: a national-scale incident-management surface is needed before any of the other 26 modules.
- Branding and naming should be **factored out into a tenant configuration table** before another tenant is provisioned. Right now Tajikistan-specific copy is hardcoded in `dashboard/page.tsx` and `login/page.tsx`.

This audit treats the ToR as the architectural compass and the UI as evidence of the first deployed vertical. Sections of the document tracker that say "demo data on the dashboard" reflect this gap.

---

## 14. Documentation quality

| Doc | State |
|---|---|
| `README.md` | Concise, accurate, reflects current state |
| `docs/ToR.md` | 120 KB, comprehensive, evidently the canonical spec |
| ADR 0001 | Stack rationale, deferred-items list — good |
| ADR 0002 | Auth MVP rationale + known gaps — good |
| ADR 0003 | Sessions + refresh + RLS + role split — excellent, names the trap (FORCE RLS vs BYPASSRLS) |
| ADR 0004 | Documents module + the RLS-hole discovery — excellent forensic narrative |
| ADR 0005 | CI rationale + the `consistent-type-imports` gotcha — good |
| ADR 0006 | Integration test suite + bug found while writing tests — good |
| ADR 0007 | Playwright + two real production bugs found while writing tests — excellent |

ADR discipline is **higher quality than most enterprise codebases**. Every architectural decision has a paper trail with rationale and triggers for re-evaluation.

**Missing docs:**
- No API reference (OpenAPI is not generated — NestJS Swagger module not installed).
- No event catalogue (no events).
- No runbook of any kind.
- No data dictionary.
- No threat model.

---

## 15. What this codebase is, in one paragraph

**A correctly built, intentionally narrow foundation for a Tajikistan national crisis-management deployment, written against a much larger ToR.** It has structurally-correct multi-tenancy, real refresh-token rotation with replay detection, a single working domain module (Documents), a coherent if early design system, integration + browser e2e tests that catch real bugs, and an honest sidebar of disabled modules announcing what's coming. It is **not** the platform the ToR describes — it is the foundation that platform could grow on. Every architectural piece that exists is well-built; every piece that doesn't exist is documented as not yet existing.

The path from here to the ToR's full vision is **5–6 phases of work over ~30 months at the team sizes named in ToR §19**. The path from here to a *credible Phase-1 MVP for one ministry* (the immediate user) is **~6 weeks of foundational additions** (rate limiting, MFA, RBAC scaffold, observability, basic incidents module) followed by the GIS + dashboard work that the dashboard mock implies.

See [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) for that path in order.

---

## 16. Audit risk register (top-level)

| # | Risk | Severity | Likelihood | Mitigation queued? |
|---|------|----------|------------|---------------------|
| R1 | No rate limiting on auth → online brute-force | Critical | High once deployed | ADR-0002 known gap |
| R2 | No MFA → single-factor account takeover | High | Med | ADR-0002 known gap |
| R3 | No RBAC → every user can read every document | Critical (within a tenant) | Cert. | Not yet queued formally |
| R4 | Audit hash chain absent → log forgery undetectable | High (for regulated tenants) | Med | Columns exist; service code TODO |
| R5 | No observability → blind operations | High | Cert. when deployed | Not queued |
| R6 | No backups → data loss on host failure | Critical | Med | Not queued |
| R7 | Secrets in `.env` files → exposure on host compromise | High | Med | Vault planned long-term |
| R8 | `tenants` table not under RLS → future feature could leak | Med | Low (no caller today) | Documented in migration |
| R9 | Tajikistan-specific UI copy in shared codebase → fork pressure on multi-tenant rollout | Med | Cert. | Not yet identified |
| R10 | No event plane → can't add the realtime / projection / collaboration features the ToR centres around | Critical for scope | Cert. | Phase-2 work |
| R11 | Playwright single-engine, web component coverage zero | Med | High | Vitest queued |
| R12 | No load testing → unknown ceiling | Med | High | Queued |

---

**End of audit.**

Further reading in this audit set:
- [IMPLEMENTATION_TRACKER.md](./IMPLEMENTATION_TRACKER.md) — module-by-module matrix
- [ARCHITECTURE_GAP_ANALYSIS.md](./ARCHITECTURE_GAP_ANALYSIS.md) — delta vs ToR
- [MODULE_STATUS_MATRIX.md](./MODULE_STATUS_MATRIX.md) — compact status table
- [ROADMAP.md](./ROADMAP.md) — MVP → National Scale phases
- [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) — ordered backlog
- [TECH_DEBT_REGISTER.md](./TECH_DEBT_REGISTER.md) — debt inventory
- [SECURITY_REVIEW.md](./SECURITY_REVIEW.md)
- [SCALABILITY_REVIEW.md](./SCALABILITY_REVIEW.md)
- [OBSERVABILITY_REVIEW.md](./OBSERVABILITY_REVIEW.md)
