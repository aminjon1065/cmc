# IMPLEMENTATION TRACKER
## Master matrix per ToR module

**Status:** snapshot as of 2026-05-24
**Source of truth:** [`docs/ToR.md`](../ToR.md) §3 + §4 + §16

**Status legend**
- `DONE` — module implemented, tested, can serve production load for the scoped capability (within Phase-1 constraints)
- `PARTIAL` — some endpoints / capabilities present, missing functional surface
- `STUB` — schema or skeleton exists, no usable behaviour
- `NOT STARTED` — neither code nor schema
- `BLOCKED` — depends on infrastructure not yet present
- `NEEDS REFACTOR` — exists but architecturally inadequate to grow

**Scoring (0–10)**

| Score axis | What it means |
|---|---|
| Compl. % | Functional completeness vs ToR section |
| Arch. | Compliance with ToR §2.3 architectural principles (event-first, tenant-first, idempotent, schema-explicit, observable, failure-isolated) |
| Prod. | Production-readiness (auth, error handling, audit, idempotency, edge cases) |
| Scale | Capability to reach the Horizon-1 user volume in ToR §1.6 (10³ users) without rewrite |
| Sec. | Security posture for what the module is supposed to do |

A `—` means "not applicable to a NOT STARTED module."

**Complexity (T-shirt):** XS (≤1 day), S (1 wk), M (2–3 wk), L (1 mo), XL (>1 mo), XXL (multi-month team effort)

---

## 3.1 Identity & Access Management

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 40 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 7/10 |
| **Code** | `apps/api/src/modules/auth/*`, `apps/api/src/modules/users/*`, `apps/api/src/common/rate-limit/*`, `apps/api/src/common/session-cache/*`, `apps/web/src/auth.ts`, `apps/web/src/middleware.ts` |

**Implemented**
- `POST /auth/login` with argon2id verify + timing-safe dummy verify
- `POST /auth/refresh` with single-use refresh + family-burn on replay
- `POST /auth/logout`
- `GET /auth/me`
- `GET /auth/sessions`, `DELETE /auth/sessions/:id`
- Session table backing every access JWT (`sid` claim → DB lookup at middleware)
- Web Auth.js v5 with credentials provider, transparent refresh dance, in-flight refresh dedup, signout-revokes-server-session event
- Edge middleware enforcing protected routes + `?next=` round-tripping
- Audit on every login outcome (durable for failures)
- **Rate limit on login/refresh** (P0.1 / ADR-0009) — Redis fixed-window with per-IP + per-email (SHA-256-hashed) counters; breach → 429 + Retry-After + durable denial audit. Trust-proxy posture limited to private networks so X-Forwarded-For can't be spoofed by external clients.
- **Session-active cache** (P0.4 / ADR-0011) — Redis-backed cache for the per-request session lookup. TTL matches access-token lifetime so failed cache DEL adds zero exposure. Invalidated on every revoke / rotate / replay-burn / expire path. Payload-mismatch falls through to DB (defence-in-depth). Cuts the hot-path DB SELECT load orders of magnitude.

**Gaps vs ToR §3.1**
- No OIDC server (no `.well-known/openid-configuration`, no JWKS endpoint, no third-party RP relationships)
- No SAML 2.0 / SSO / SCIM
- No service-account / API-key issuance
- ~~No MFA~~ ✅ TOTP MFA landed (P1.2 / ADR-0020): encrypted secret at rest, one-time backup codes, two-step `mfa_required` login, enrol/confirm/disable. WebAuthn + per-tenant enforcement still pending.
- ~~No password reset flow~~ ✅ password reset landed (P1.3 / ADR-0021): `password_resets` (single-use sha256-hashed token, RLS), self-service (no-enumeration) + admin-initiated (`user:manage`-gated) flows, race-safe CAS completion that revokes all sessions but leaves MFA intact, pluggable notifier (dev logger now → SMTP at P1.6). Email delivery still pending (P1.6).
- No tenant picker for cross-tenant email collision (TD-038; also makes ambiguous-email self-reset a no-op)
- ~~No rate limiting~~ ✅ closed by P0.1 (auth endpoints); global rate-limit still pending → P0.9
- No JIT provisioning from SSO claims
- RS256 + JWKS + key rotation (today HS256 — fine until services split, called out in ADR-0002)
- No revocation list propagated via NATS to other gateways (no other gateways exist)
- No bloom-filter revocation cache in Redis

**Blockers / deps**
- Redis cache for session-active lookup (perf, not correctness)
- NATS for revocation broadcast (only matters when a second service exists)

**Complexity to complete to ToR §3.1**
- ~~MFA + rate limit + password reset: **M**~~ ✅ all landed (P0.1 rate-limit, P1.2 MFA, P1.3 password reset)
- OIDC server (Keycloak adoption or self-built with `oidc-provider`): **L**
- SAML / SCIM: **L**
- RS256 + JWKS rotation: **S**

---

## 3.2 Multi-Tenancy

| field | value |
|---|---|
| **Status** | DONE (for shared-schema RLS model) |
| **Compl. %** | 50 % (one of the three tenancy options) |
| **Arch.** | 9/10 |
| **Prod.** | 8/10 |
| **Scale** | 6/10 |
| **Sec.** | 9/10 |
| **Code** | RLS migrations + `TenantContextMiddleware` + `TenantTransactionInterceptor` + `TenantDatabaseService` + `cmc_app` Postgres role |

**Implemented**
- Shared-schema RLS via `app.tenant_id` GUC
- `cmc_app` runtime role (`NOSUPERUSER NOBYPASSRLS`) + `FORCE ROW LEVEL SECURITY` on every tenant-scoped table
- `runPrivileged` escape hatch with try/finally GUC reset
- Cross-tenant access regression-tested at the API layer (`rls.e2e-spec.ts`)
- **Per-tenant branding extracted to data** (P0.11 / ADR-0018): `tenant_branding` table (RLS-isolated) + context-aware `GET /branding` (authed→own, anon→default tenant); generic `DEFAULT_BRANDING` in contracts, TJ-CMC values seed-only; web fetches branding server-side (no hardcoded org identity left). 6 isolation/no-leak e2e tests.

**Gaps vs ToR §3.2**
- No separate-schema-per-tenant option for high-isolation modules
- No dedicated-DB-per-tenant deployment mode
- No per-tenant DEK / envelope encryption via KMS/Vault Transit
- No tenant migration tooling (grow a tenant onto dedicated infrastructure)
- No tenant-scoped Redis namespacing pattern (Redis not yet wired)
- No per-tenant OpenSearch indices (OpenSearch not present)
- No tenant sharding strategy

**Complexity to complete:** **L** (cryptographic tenancy + migration tooling)

---

## 3.3 RBAC/ABAC Authorization

| field | value |
|---|---|
| **Status** | PARTIAL (RBAC ✅; ABAC pending) |
| **Compl. %** | 45 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 8/10 |
| **Code** | `packages/db/src/schema/rbac.ts`, `apps/api/src/modules/rbac/*`, `apps/api/src/common/authz/*`, `apps/api/src/common/permission-cache/*`, `packages/contracts/src/rbac.ts` |

**Implemented (P1.1 / ADR-0019)**
- Per-tenant `roles` + global `permissions` catalog + `role_permissions` + `user_roles`, all RLS-isolated (migration `0006`).
- `PERMISSION_CATALOG` + `SYSTEM_ROLES` in `@cmc/contracts` — single source of truth for seed + guard strings.
- `@Authorize('domain:action')` decorator + `AuthorizeGuard` (ALL-required; 403 + durable `rbac.access.denied` audit). Handles the guards-before-interceptors trap via `runForTenant` in the resolve path.
- `PermissionCacheService` (Redis, fail-open, TTL 300s, invalidated on assign/remove). `RbacService` (resolve/hasPermission/listRoles/listUserRoles/assign/remove/enforce).
- `RbacController`: roles list, user-roles list, assign/remove (gated `role:read`/`role:assign`).
- System roles (`tenant_admin`/`operator`/`auditor`) seeded per tenant; documents `@Authorize`-protected per route. 9 e2e tests; live-validated.

**Gaps vs ToR §3.3 / §6.2**
- No ABAC / OPA / Rego (PDP/PEP/PIP, attribute policies) — RBAC only.
- ~~No custom (non-system) role CRUD or permission editing API yet~~ ✅ custom-role CRUD landed (P1.4c / ADR-0022): `role:manage` perm, `GET /rbac/permissions` + `POST/PATCH/DELETE /rbac/roles`, system roles immutable, perm-cache invalidation on change, `/admin/roles` editor.
- No permission inheritance / hierarchy; no decision-cache metrics; system-role immutability is a flag, not a DB trigger.

**Complexity to complete to §3.3:** **XL** for OPA-driven ABAC end-to-end (RBAC done).

**Sequencing note:** ✅ satisfied — RBAC now precedes the domain modules (P1.5 Incidents onward ship `@Authorize` from day one).

---

## 3.4 GIS & Geospatial Intelligence (deep dive §4)

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 2 % (PostGIS extension installed) |
| **Arch.** | — |
| **Prod.** | — |
| **Scale** | — |
| **Sec.** | — |
| **Code** | `infra/postgres/init/01-extensions.sql` |

**Implemented**
- PostGIS + postgis_topology extensions enabled in the dev Postgres image

**Gaps**
- All of ToR §4: no spatial schema, no tile server, no MapLibre frontend, no geofencing, no live-tracking pipeline, no spatial analytics, no clustering/heatmap, no coordinate-system handling, no caching layers

**Complexity:** **XXL** (GIS is a whole product surface; ToR §19.4 calls for 3–5 dedicated GIS engineers).

---

## 3.5 Analytics & Reporting

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |
| **Arch.** | — |
| **Prod.** | — |
| **Scale** | — |
| **Sec.** | — |

**Implemented** — none.

**Gaps** — entirety of §3.5: no ClickHouse, no projector workers, no pre-built dashboards, no ad-hoc query DSL, no scheduled reports, no time-series/cohort/funnel analytics.

**Dashboard UI exists** (`/dashboard`) but renders **hardcoded demo data** with one real `/auth/me` panel. It's a UX scaffold, not an analytics surface.

**Complexity:** **XL** (ClickHouse cluster + projectors + dashboard builder + materialised views).

---

## 3.6 Realtime Event System

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |

**Implemented** — none.
**Gaps** — no NATS/Kafka, no event bus, no outbox table, no AsyncAPI schemas, no idempotent consumer pattern, no `trace_id` / `causation_id` / `correlation_id` propagation.

**Implication:** every other module that the ToR describes as "emits an event" or "subscribes to an event" is blocked on this. Audit log is closest analogue but is not consumable as an event stream.

**Complexity:** **L** for the event-bus + outbox + first 2–3 consumers; **XL** to operationalise (DLQ, replay, monitoring, schema registry).

---

## 3.7 Dashboard Builder

| field | value |
|---|---|
| **Status** | NOT STARTED |

The static `/dashboard` page is a fixed-layout demo, not a builder. ToR §3.7 requires drag-and-drop widget grid, datasource binding, parameter/filter/drill-through. **Complexity: L.**

---

## 3.8 File Management System

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 20 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 6/10 |
| **Sec.** | 7/10 |
| **Code** | `apps/api/src/modules/storage/*`, `apps/api/src/modules/documents/*` (overlaps with §3.9) |

**Implemented**
- Pre-signed PUT for direct browser upload
- Finalize HEADs the object, captures ETag, cross-checks size
- Pre-signed GET with `Content-Disposition` for download
- Soft-delete with best-effort object delete

**Gaps vs ToR §9 (Enterprise File Management)**
- No hierarchical folder model (no `folders` table, no `ltree` path)
- No permission inheritance
- No versioning (`document_versions` child table)
- No previews / thumbnail pipeline
- No EXIF / PDF metadata extraction
- No external sharing links
- No retention policies / legal hold
- No object-level encryption per tenant (DEK/KEK)
- No tus.io resumable upload (today is single PUT)
- No multipart upload for >100 MB files (today config max is 100 MB; ToR pattern is multipart)
- No content-type sniffing / magic-byte verification
- No virus scanning
- No CDN / edge cache
- No content extraction → OpenSearch indexing
- No `failed`-status object lifecycle rule

**Complexity to complete to ToR §9:** **XL**

---

## 3.9 Enterprise Document Management (ECM)

| field | value |
|---|---|
| **Status** | PARTIAL (file-level only, no structured ECM yet) |
| **Compl. %** | 10 % |
| **Code** | `apps/api/src/modules/documents/*` |

**Implemented** — file-level upload/download/list/delete as a flat namespace per tenant.

**Gaps**
- No document types / metadata schemas (contract, decree, regulation, report)
- No lifecycle states (draft → review → approved → published → archived)
- No diff (textual / structural)
- No classification / tagging (manual + AI)
- No legal hold
- No DoD 5015.2-style records management
- No digital signatures (eIDAS / PKCS#7)
- No retention policies

**Complexity:** **XL**.

---

## 3.10 Workflow / BPM Engine

| field | value |
|---|---|
| **Status** | NOT STARTED |

No Temporal, no BPMN, no FSM library, no approval tables, no SLA timer, no escalation policies, no visual builder. **Complexity: XL** (Temporal integration alone is a multi-week task; the visual builder + library of workflows is a multi-month team effort).

---

## 3.11 Chat & Messaging

| field | value |
|---|---|
| **Status** | NOT STARTED |

No channels, no messages, no presence, no read receipts, no fanout service, no Redis pub/sub. **Complexity: XL.**

---

## 3.12 Video Conferencing

| field | value |
|---|---|
| **Status** | NOT STARTED |

No LiveKit / Jitsi, no coturn, no signalling. **Complexity: XXL** (operational discipline as much as code).

---

## 3.13 Notification System

| field | value |
|---|---|
| **Status** | P1.6 COMPLETE (phases a–c) |
| **Compl. %** | 60 % (in-app + web center + email + prefs) |

**In-app (P1.6a / ADR-0024):** `notifications` table (recipient-scoped, RLS) + self-scoped center (`GET /notifications` + unread-count + mark-read/read-all, auth-only). Best-effort dispatch from `IncidentsService` on assign (→ assignee) + transition (→ reporter+assignee), actor-excluded, in its own tx (never fails the incident op). 6 e2e, suite 159/159, live-validated.

**Web center (P1.6b / ADR-0024):** topbar bell + unread badge (polls unread-count every 30s) + dropdown of latest 8 (deep-link → mark-read) + "Mark all read"; `/notifications` full page; sidebar entry + middleware. Client → server-actions (token stays server-side), fail-safe. Web build green; suite 159/159.

**Email + prefs (P1.6c / ADR-0024):** `MailService` (Nodemailer/`MAIL_*`, best-effort, dev-logs/prod-drops) + **Mailpit** in compose. **Password-reset now emails** (swapped the P1.3 dev-logger → `EmailResetNotifier`, closing that gap). Email-on-notification (`create` sends + stamps `dispatched_at`). `user_notification_prefs` per-kind (RLS, migration `0011`) applied in dispatch; GET/PUT prefs + web toggle grid. Simple HTML templates. +5 e2e, suite 164/164, live-validated (reset + incident emails in Mailpit).

**P1.6 complete (a–c).** Still future: transactional outbox + worker, event bus, quiet-hours, Web Push/VAPID, webhook delivery, MJML.

**Complexity:** **L** for in-platform + email + webhook; web push and mobile push are individually **M**.

---

## 3.14 Search Engine

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 3 % |

Postgres `pg_trgm` extension is installed. Documents list endpoint uses `ILIKE` substring search with proper wildcard escaping — that's the entire search surface. No federated search, no BM25, no faceting, no autocomplete, no saved searches, no permission-aware indexing, no OpenSearch cluster.

**Complexity:** **XL** for the full federated search; **M** for an interim Postgres `tsvector` + GIN approach.

---

## 3.15 Audit & Activity Logging

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 85 % |
| **Arch.** | 9/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 8/10 |
| **Code** | `apps/api/src/modules/audit/{audit.service,audit-chain.service,audit.controller}.ts`, `packages/db/src/schema/{audit-log,audit-chain-anchor}.ts`, `0002_rls_policies.sql`, `0012`/`0013` |

**Implemented**
- Append-only table with `tenantId`, `actorId`, `actorType`, `action`, `resourceType`, `resourceId`, `outcome`, `ip`, `userAgent`, `metadata`, `prev_event_hash`, `this_hash`, `occurred_at`
- RLS: insert permissive, select scoped, update/delete only via bypass
- Durable-on-demand writes (`runPrivileged` survives request rollback)
- Audit on login (success/failure/denied), refresh, logout, document init/finalize/download/delete
- `request_id` (P0.3) + `trace_id` (P0.6) populated on every row
- **Tamper-evident hash chain** (P1.11a / ADR-0029): `seq` + async sealer fills `prev_event_hash`/`this_hash` per `(tenant, UTC day)` chain; `verifyChain` pinpoints tampered rows
- **Daily Merkle anchor under S3/MinIO Object Lock (WORM)** (P1.11b): `@nestjs/schedule` cron + `audit_chain_anchor` table; `rootMatches` cross-check; gated verify/seal/anchor endpoints
- **SIEM export** (P1.12 / ADR-0030): worker tail-reads by durable `seq` cursor (`audit_export_cursor`), ships **RFC 5424 syslog / CEF** via pluggable sink (noop/stdout/file/tcp), at-least-once; gated status/flush endpoints
- **ClickHouse archive + analytics projection** (P2.2 / ADR-0034): cursor-tail ETL (`projection_cursors`) → `cmc.audit_events` + `audit_daily_stats` MV; gated projection status/flush endpoints (live: 160→160)

**Gaps vs ToR §3.15**
- Export side done; a running SIEM (Wazuh/OpenSearch) + managed forwarder (Vector/Fluent Bit) + TLS on the TCP sink → H-tier
- No retention policy enforcement; no legal-hold suspension
- Dedicated `audit:read` permission + auditor role (currently reuses `tenant:manage`)
- `system` (tenant-less) chain verification is privileged-only — no platform-superadmin endpoint yet
- No saved-investigation tooling; reads have no pagination (no audit explorer UI)
- ClickHouse retention/TTL for very old `audit_events` (archive itself done — P2.2)

**Complexity to complete:** ~~hash chain + Merkle anchor~~ ✅ done (P1.11); **S** for SIEM export (P1.12); **L** for the audit explorer UI.

---

## 3.16 Knowledge Base / Wiki

| field | value |
|---|---|
| **Status** | NOT STARTED |

No spaces, pages, block editor, version history, comments, page-permissions, templates. Real-time collab (Yjs) also absent (§3.22). **Complexity: XL.**

---

## 3.17 Integration / API Gateway

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |

No Kong / Envoy, no WAF, no quota table, no API key issuance, no per-client rate limit. The Next.js BFF is the closest thing to a gateway today. **OpenAPI doc generation ✅** (P1.10 / ADR-0028): `@nestjs/swagger` + CLI plugin (request DTOs) + Zod-contract response schemas (82 components) served at gated `/v1/openapi.json` (`tenant:manage`) with Swagger UI at web `/admin/api-docs`.

**Complexity:** **L** to add Caddy + a NestJS rate-limit guard + OpenAPI generation; **XL** for the full Kong/Envoy + WAF + quota + analytics surface.

---

## 3.18 AI-Ready Architecture (deep dive §16)

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 2 % (pgvector installed) |

No vector tables, no embedding workers, no LLM gateway, no RAG, no copilot infrastructure, no OCR, no LLM-call audit. **Complexity: XXL.**

---

## 3.19 Administration Panel

| field | value |
|---|---|
| **Status** | P1.4 COMPLETE (phases a–d) |
| **Compl. %** | 60 % (foundation + Users + Roles + Tenant settings) |

**Foundation (P1.4a / ADR-0022):** `GET /rbac/me` (current user's effective roles+permissions, self-scoped) drives a gated `/admin` section — `getMyAccess()` (fail-closed, request-memoised) + an `/admin` layout redirect for non-admins + the now-enabled "Administration" sidebar entry + middleware protection + an `/admin` overview. The API stays the real authz boundary (every admin endpoint `@Authorize`-gated); the web redirect is UX.

**Users (P1.4b):** `GET/POST/PATCH/DELETE /users` (`user:manage`, RLS → cross-tenant 404) + `/admin/users` (list, create form, per-row activate/deactivate, reset-password-reveal, delete, role add/remove). Passwordless invite → admin-reset (P1.3) sets the first password (no email yet). Deactivate/delete revoke sessions + block re-login; self-deactivate/delete guarded. `SessionsService` extracted to `SessionsModule` to avoid the Auth↔Users DI cycle. Audited. 11 e2e; suite 126/126; web build green; live-validated.

**Roles (P1.4c):** `role:manage` perm + `GET /rbac/permissions` + `GET/POST/PATCH/DELETE /rbac/roles`. System roles immutable (403 on edit/delete); custom-role slug+perm validation (409/400); perm-cache `delTenant` on permission change/delete. `/admin/roles` editor (create + inline edit w/ domain-grouped permission picker; system read-only). 7 e2e; suite 133/133; live-validated.

**Tenant settings (P1.4d):** `tenant:manage` perm + `GET/PATCH /tenant` (rename own tenant) + method-gated `PUT /branding` (localeDefault/logoUrl/copy, copy-merge upsert; `GET /branding` stays public). `/admin/tenant` Identity + Branding forms. 7 e2e; suite 140/140; live-validated.

**P1.4 complete (a–d).** Remaining for a "full" admin console (beyond P1.4 scope): cross-tenant platform-superadmin administration; step-up re-auth for destructive actions; feature flags / quotas / SSO+SMTP config. Deferred by decision. **Complexity (done): L.**

---

## 3.20 Monitoring & Observability (deep dive §14)

| field | value |
|---|---|
| **Status** | IN PROGRESS (logs + metrics + traces triangle closed) |
| **Compl. %** | 55 % |

Structured JSON logging with `request_id`+`trace_id`+`tenantId`+`userId` (P0.3 / ADR-0010); OTEL traces + trace_id-in-logs (P0.6 / ADR-0013); Prometheus RED metrics + Grafana dashboard (P0.7 / ADR-0014); health probes (P0.8 / ADR-0015); **Loki log aggregation** (pino-loki API + Promtail containers + request_id dashboard, P1.7 / ADR-0025); **Tempo traces + three-signal cross-link** (Loki→Tempo on `traceId`, Tempo→Loki via `tracesToLogsV2`) + **Alertmanager** with a 5xx-ratio rule + target-down rule (P1.8 / ADR-0026). The whole stack is `pnpm obs:up`.

**Remaining:** alert **delivery/paging** (Alertmanager receiver is a no-op until a paging target / platform-superadmin recipient exists), Prometheus exemplars (metric→trace jump), log-based metrics, tail sampling, production object-store Tempo/Loki + non-root Tempo. **Complexity:** **L** done; **XL** at proper SRE quality.

---

## 3.21 Data Import/Export

| field | value |
|---|---|
| **Status** | NOT STARTED |

No BullMQ jobs, no CSV/Excel/JSON/GeoJSON parsers, no quarantine queue, no validation pipeline, no CDC, no Airflow/Dagster. **Complexity: XL.**

---

## 3.22 Realtime Collaboration

| field | value |
|---|---|
| **Status** | NOT STARTED |

No Yjs, no WebSocket-backed CRDT provider, no presence cursors, no anchored comments. **Complexity: XL** (specialised area).

---

## 3.23 Task & Case Management

| field | value |
|---|---|
| **Status** | NOT STARTED |

No `cases` table, no case types, no SLA timers, no assignment policies, no activity timeline. Dashboard UI references "Cases Open" with hardcoded "142" — this is the second highest-value module gap after the GIS map. **Complexity: L–XL.**

---

## 3.24 Media Management

| field | value |
|---|---|
| **Status** | NOT STARTED |

No transcoding workers, no FFmpeg pipeline, no HLS streaming, no signed URLs for media-specific access patterns. **Complexity: L.**

---

## 3.25 Geospatial Analytics

(Sub-scope of §3.4 / §4.) **NOT STARTED.**

---

## 3.26 Operational Monitoring Center

| field | value |
|---|---|
| **Status** | NOT STARTED |

This is the **product surface the UI implies**. No live event ticker, no multi-monitor layout, no real KPI tiles backed by data, no time-replay. The hero ribbon "ELEVATED ALERT · Flood Watch" is hardcoded copy. **Complexity: XL** (needs §3.6 events, §3.27 incidents, §3.4 GIS, §3.23 cases all in place).

---

## 3.27 Incident / Event Management

| field | value |
|---|---|
| **Status** | P1.5 COMPLETE (phases a–c) |
| **Compl. %** | 55 % (backend + operator UI + live dashboard) |

**Backend (P1.5a / ADR-0023):** `incidents` table (severity 1-5, status, free-text type/region/source, summary/description, optional lat/lng, occurred_at, reported_by/assigned_to, resolved_at, soft-delete) under RLS. Status **state machine** (reported→triaged→in_progress→resolved→closed +cancelled, reopen) shared API↔web via `INCIDENT_TRANSITIONS`. 6 `incident:*` permissions (resolve gated above write). CRUD + list/filters/pagination + assign + stats. Audited. 11 e2e, suite 151/151, live-validated.

**Web (P1.5b / ADR-0023):** `/incidents` list (filter bar→URL params, paginated table, gated report form) + `/incidents/[id]` detail with a state-machine-aware Actions panel (reachable transitions only; resolve hidden without `incident:resolve`), member-dropdown assign, inline edit, gated delete. `GET /incidents/assignees`. Nav + middleware wired. Suite 152/152; web build green.

**Dashboard (P1.5c / ADR-0023):** the operational dashboard's incident widgets (hero counts, KPI strip, Active-by-Region/Type bars, Priority Incidents) read `GET /incidents/stats` + `GET /incidents?active=true` (new `active` filter); hardcoded arrays removed; fail-safe. Suite 153/153; live-validated.

**P1.5 complete (a–c).** Still future: severity-driven SLA/auto-escalation, per-incident activity timeline, command roles (Commander/Comms/Ops), post-mortem template, MTTD/MTTR analytics, real geometry (GIS module). **Complexity (done): L–XL.**

---

## Cross-cutting infrastructure trackers

### Event plane (NATS JetStream)

| | |
|---|---|
| Status | PARTIAL (P2.1 / ADR-0031) — outbox + relay + first producer done; consumers next |
| Files | `apps/api/src/modules/events/{outbox.service,relay.service,event-publisher,nats-event-publisher,events.controller}.ts`, `packages/db/src/schema/outbox.ts` (0015), `packages/contracts/src/events.ts`, `infra/docker-compose.yml` (nats) |
| Done | NATS JetStream container; **transactional `outbox`** (atomic write via ambient tx — no dual-write); **relay** → `tenant.{id}.{aggregate}.{event}.v{n}` (at-least-once, JetStream msgID dedup, advisory-locked); `EventPublisher` seam (real NATS lazy-imported only when enabled); **incidents producer** (created/transitioned/assigned); **first durable consumer** — notifications-from-events (P2.4 / ADR-0032: `consumed_events` dedup ledger, `DeliverPolicy.New`, handler/subscriber split, zero-regression inline fallback). Live-validated end-to-end + trace-correlated |
| Remaining | dead-letter / max-deliver, outbox + consumed_events pruning, WebSocket fan-out (P2.3b — gateway scaffolded P2.3a), multi-worker scale |
| Blocks | §3.6, §3.13, §3.20, §3.22, §3.26, §3.27, audit projection, geofence-trigger, etc. |

### Analytics plane (ClickHouse)

| | |
|---|---|
| Status | PARTIAL (P2.5/P2.2/P2.6) — single-shard CH + 2 projections + MVs + query API |
| Files | `apps/api/src/modules/analytics/{clickhouse.client,clickhouse-client.impl,incident-projection.consumer,incident-projection.subscriber,audit-projection.service,dashboard-analytics.service,dashboard-trend,analytics.controller,analytics.module}.ts`, `infra/clickhouse/init/{01-schema,02-audit}.sql`, `infra/docker-compose.yml` (clickhouse) |
| Done | ClickHouse container (HTTP 8123); incident schema (`incident_events` + daily-by-region MV) + audit schema (`audit_events` + daily-stats MV); gated lazy `@clickhouse/client`; **incident projection consumer** (event-bus, DeliverPolicy.All, dedup ledger — P2.5/ADR-0033) + **audit projection** (cursor-tail ETL, `projection_cursors` — P2.2/ADR-0034). Both live-validated end-to-end. **Query API**: `DashboardAnalyticsService` + `GET /v1/analytics/dashboard` (tenant-scoped CH incident trend, gap-filled, `incident:read`) → web dashboard `TrendChart` (P2.6/ADR-0036) |
| Remaining | more MVs/widgets (by-region trend, audit activity, MTTR), saved reports, parameterised CH bindings, CH migration tooling, sharding/replication (H-tier), retention/TTL |
| Blocks | §3.5, dashboards, audit-archive, position-history queries |

### Search plane (OpenSearch)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.14, parts of §3.8/§3.9 |
| Complexity | L to deploy + index documents/messages; XL for permission-aware indexing + hybrid BM25+vector |

### Vector plane (Qdrant / pgvector)

| | |
|---|---|
| Status | PARTIAL (pgvector installed, unused) |
| Blocks | §3.18 / §16 |
| Complexity | M to start indexing with pgvector; L to migrate to Qdrant when scale demands |

### Realtime plane (WebSocket gateway)

| | |
|---|---|
| Status | DONE (P2.3 / ADR-0035 — 2026-06-02) — single-instance |
| Done | `RealtimeModule` in `apps/api` (in-process, not a separate app — reuses JwtService/RBAC/NATS/config). Native `ws`, `noServer` server on the HTTP `upgrade` event (gated `REALTIME_ENABLED`); **auth-before-handshake** (`WsAuthService`: JWT verify + session-active; `cmc-bearer` subprotocol or `?access_token=`). JSON protocol (`@cmc/contracts/realtime`); **tenant-isolated + fail-closed per-subscription RBAC** subscriptions (perms resolved at connect), NATS-style matcher, in-memory registry. `RealtimeFanoutSubscriber` (ephemeral JetStream, `DeliverPolicy.New`, `tenant.>` → `broadcast()`). `GET /v1/realtime/status`. 14 tests; full-chain live smoke (POST incident → WS event). |
| Remaining | browser client hook/UI (with P2.6); **Redis pub/sub** cross-instance fan-out (multi-instance); mid-connection RBAC-revocation; presence/optimistic-updates (§7.3/§7.5) |
| Files | `apps/api/src/modules/realtime/{realtime.gateway,realtime-registry.service,realtime-fanout.subscriber,ws-auth.service,subject-match,subject-permission,realtime.controller,realtime.module}.ts`, `packages/contracts/src/realtime.ts` |
| Blocks | §3.11, §3.22, §3.26 |
| Complexity | L (gateway done; Redis pub/sub fan-out = the remaining scale piece) |

### Redis substrate (cache / queue / pub-sub host)

| | |
|---|---|
| Status | DONE (client wired) — 2026-05-25, P0.2, ADR-0008 |
| Files | `apps/api/src/modules/redis/{redis.tokens.ts, redis.module.ts, redis-keys.ts}` |
| Library | `ioredis@^5.4.1` |
| Consumers | none yet — P0.1 rate-limit, P0.4 session cache, P1.6 notifications, P2.1 NATS-adjacent, P2.13 BullMQ, P2.3 WS pub/sub are the queued consumers |
| Test | `apps/api/test/e2e/redis.e2e-spec.ts` — 4 tests; ping, set/get TTL, GETNAME, status |
| Observability today | NestJS Logger on connect/ready/reconnecting/end/error |
| Deferred to | P0.7 metrics · P0.8 deep health probe |

### Workflow plane (Temporal)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.10, §3.23, §3.27 |
| Complexity | M to integrate; XL for the visual builder + library |

### Observability plane (OTEL/Prom/Loki/Tempo/Grafana)

| | |
|---|---|
| Status | IN PROGRESS — logs ✅ (P0.3/ADR-0010), traces ✅ emit (P0.6/ADR-0013), metrics ✅ (P0.7/ADR-0014); trace collector + alerting + log aggregation pending |
| Logs | Pino JSON + `request_id` + `trace_id` correlation; Loki shipping → P1.7 |
| Traces | OTEL `NodeSDK` emits HTTP/DB(`db.tx`)/S3/Redis spans; `X-Trace-Id` header; W3C propagation; trace_id on audit rows. Files: `apps/api/src/tracing.ts`, `request-context.middleware.ts`, `tenant-database.service.ts`. Exporter gated on `OTEL_EXPORTER_OTLP_ENDPOINT`; Tempo collector → P1.8 |
| Metrics | ✅ `prom-client` `/metrics` (P0.7 / ADR-0014): HTTP RED histogram (matched-route label), DB saturation (`cmc_db_transactions_*`, `cmc_db_pool_max`), Node defaults. Prometheus + Grafana in `infra/observability-compose.yml` (`pnpm obs:up`); dashboard `cmc-api-red.json`. Files: `apps/api/src/modules/metrics/*`. Business metrics + alerting pending |
| Health probes | ✅ liveness `/health` + readiness `/health/ready` (200/503, parallel timeout-bounded PG/Redis/MinIO probes) + `/health/deep` (authed, per-dep timings) (P0.8 / ADR-0015). Files: `apps/api/src/modules/health/*`. startup + synthetic monitor pending |
| Alerting | none → P1.8 (Alertmanager) |
| Blocks | running the system in any non-dev environment safely |
| Complexity | M to instrument + stack-up; L to operate well |

### Notification plane (in-platform + email + webhook + web push)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.13, §3.27 (escalation), §3.10 (approvals) |
| Complexity | M for in-platform + email; L for the rest |

### Secrets plane (Vault)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | any non-dev deployment |
| Complexity | M to deploy + adopt for first workload |

### Backups plane (Postgres)

| | |
|---|---|
| Status | DONE (logical nightly dump; PITR deferred) — 2026-05-25, P0.5, ADR-0012 |
| Files | `infra/backup/{Dockerfile, entrypoint.sh, backup.sh, restore.sh}`, `infra/docker-compose.yml` (postgres-backup service) |
| Tooling | alpine + postgresql16-client + `mc` + busybox crond |
| Cadence | `BACKUP_SCHEDULE_CRON` (default `0 3 * * *` UTC), retention `BACKUP_RETENTION_DAYS` (default 7d) |
| Storage | MinIO bucket `cmc-backups`, key `postgres/YYYY/MM/cmc-<ISO-Z>.dump` |
| Manual | `pnpm db:backup` / `pnpm db:restore <key\|latest>` (TTY confirmation + `CONFIRM_RESTORE=yes` for scripted callers) |
| Drill | rehearsed end-to-end: seed → backup → wipe → restore → e2e auth suite green |
| Observability today | `docker compose logs postgres-backup` |
| Deferred to | P0.7 (Prometheus metric) · P1.8 (Alertmanager "no fresh backup in 36 h") · P2.14 (Vault-encrypted dump bytes) · P3 (WAL streaming / PITR) |

### Edge / TLS plane (Caddy)

| | |
|---|---|
| Status | DONE (edge + app images; full stack live-validated) — 2026-05-25, P0.9 (ADR-0016) + P0.10 (ADR-0017) |
| Files | `infra/caddy/Caddyfile`, `infra/deploy-compose.yml`, `infra/.env.production.example` |
| TLS | automatic — Let's Encrypt in prod, internal CA for `*.localhost` dev |
| Routing | subdomain: `{$APP_HOST}`→web, `{$API_HOST}`→API. Path-based routing now **unblocked** — `/v1` (P1.9 / ADR-0027) removed the web/API path collision (`/documents` vs `/v1/documents`) — but subdomain routing is retained (no edge rework in P1.9) |
| Edge policy | HSTS + nosniff + X-Frame DENY + Referrer-Policy + `-Server` + gzip; `/metrics` + `/health/deep` → 404 (ADR-0014/0015 follow-ons) |
| Upstreams | ✅ `api:3001` / `web:3000` compose service names (flipped at P0.10) |
| App images | ✅ `api` + `web` distroless non-root images built + run in the overlay (P0.10 / ADR-0017); `api` joins external `cmc-net` |
| Manual | `pnpm infra:up` (core) then `pnpm deploy:up/down/logs/ps/validate` |
| Validated | full stack: certs issued; HTTPS/2 → API 200; /health/ready 200 all-deps-up (minio via service name); /metrics 404; web 200; all 3 containers healthy |
| Deferred to | image scanning/SBOM (TD-029) · CI build-push · edge WAF/rate-limit · P4 (mTLS mesh) |

---

## Summary table

| Module | Status | Compl. % | Complexity to finish |
|---|---|---|---|
| 3.1 IAM | PARTIAL | 30 % | L |
| 3.2 Multi-Tenancy | DONE (shared-schema mode) | 50 % | L (for cryptographic + migration tooling) |
| 3.3 RBAC/ABAC | NOT STARTED | 0 % | L → XL |
| 3.4 GIS | NOT STARTED | 2 % | XXL |
| 3.5 Analytics | NOT STARTED | 0 % | XL |
| 3.6 Realtime Events | NOT STARTED | 0 % | L → XL |
| 3.7 Dashboard Builder | NOT STARTED | 0 % | L |
| 3.8 File Mgmt | PARTIAL | 20 % | XL |
| 3.9 ECM | PARTIAL | 10 % | XL |
| 3.10 Workflow | NOT STARTED | 0 % | XL |
| 3.11 Chat | NOT STARTED | 0 % | XL |
| 3.12 Video | NOT STARTED | 0 % | XXL |
| 3.13 Notifications | P1.6 DONE (a–c) | 60 % | L |
| 3.14 Search | NOT STARTED | 3 % | XL |
| 3.15 Audit | PARTIAL | 45 % | M |
| 3.16 Wiki | NOT STARTED | 0 % | XL |
| 3.17 API Gateway | NOT STARTED | 0 % | L → XL |
| 3.18 AI Readiness | NOT STARTED | 2 % | XXL |
| 3.19 Admin Panel | P1.4 DONE (a–d) | 60 % | L |
| 3.20 Observability | NOT STARTED | 5 % | L → XL |
| 3.21 Import/Export | NOT STARTED | 0 % | XL |
| 3.22 Realtime Collab | NOT STARTED | 0 % | XL |
| 3.23 Cases | NOT STARTED | 0 % | L → XL |
| 3.24 Media | NOT STARTED | 0 % | L |
| 3.25 Geo Analytics | NOT STARTED | 0 % | sub-scope of 3.4 |
| 3.26 Ops Monitoring | NOT STARTED | 0 % | XL |
| 3.27 Incidents | P1.5 DONE (a–c) | 55 % | L → XL |

**Aggregate completion against ToR §3 surface:** ~**6 %**.
This is **the right number for a Phase-1 foundation that has not yet entered Phase 2**.

See [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) for sequencing of remaining work.
