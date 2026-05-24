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
- No MFA (TOTP, WebAuthn, backup codes) — ToR §6.11
- No password reset flow
- No tenant picker for cross-tenant email collision
- ~~No rate limiting~~ ✅ closed by P0.1 (auth endpoints); global rate-limit still pending → P0.9
- No JIT provisioning from SSO claims
- RS256 + JWKS + key rotation (today HS256 — fine until services split, called out in ADR-0002)
- No revocation list propagated via NATS to other gateways (no other gateways exist)
- No bloom-filter revocation cache in Redis

**Blockers / deps**
- Redis cache for session-active lookup (perf, not correctness)
- NATS for revocation broadcast (only matters when a second service exists)

**Complexity to complete to ToR §3.1**
- MFA + rate limit + password reset: **M**
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
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |
| **Arch.** | — |
| **Prod.** | — |
| **Scale** | — |
| **Sec.** | — |
| **Code** | None |

**Implemented**
- (none)

**Gaps**
- All of ToR §3.3 / §6.1 / §6.2: no roles, no permissions, no policies, no PDP/PEP/PIP, no Rego, no `@AuthorizeWith` guard, no decision cache, no system-role table, no permission inheritance

**Operational consequence**
Today **every authenticated user can read every document in their tenant.** The only existing access boundary is tenant. Within a tenant, no segregation by clearance, owner, team, or role exists.

**Complexity:** **L** for RBAC, **XL** for OPA-driven ABAC end-to-end.

**Sequencing note:** must precede any module where users have different responsibilities (Cases, Workflow approvals, GIS layer editing).

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
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |

No `notifications` table, no MJML templates, no per-channel workers, no per-user preferences, no quiet-hours logic, no SMTP relay configured, no Web Push VAPID, no webhook delivery.

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
| **Compl. %** | 45 % |
| **Arch.** | 7/10 |
| **Prod.** | 7/10 |
| **Scale** | 6/10 |
| **Sec.** | 6/10 |
| **Code** | `apps/api/src/modules/audit/audit.service.ts`, `packages/db/src/schema/audit-log.ts`, `0002_rls_policies.sql` |

**Implemented**
- Append-only table with `tenantId`, `actorId`, `actorType`, `action`, `resourceType`, `resourceId`, `outcome`, `ip`, `userAgent`, `metadata`, `prev_event_hash`, `this_hash`, `occurred_at`
- RLS: insert permissive, select scoped, update/delete only via bypass
- Durable-on-demand writes (`runPrivileged` survives request rollback)
- Audit on login (success/failure/denied), refresh, logout, document init/finalize/download/delete

**Gaps vs ToR §3.15**
- `prev_event_hash` / `this_hash` columns exist but nothing populates them — no tamper-evident chain
- No daily Merkle root / external notary anchor
- No SIEM forwarder (syslog RFC 5424 / CEF)
- No retention policy enforcement
- No legal-hold suspension of deletion
- WORM property is convention only — `audit_log` policy denies UPDATE/DELETE except for `bypass_rls` which the application code can still set; tightening would require a separate auditor role with `nbypass` or storage-level WORM (S3 Object Lock)
- No `request_id` / `trace_id` populated (columns exist)
- No saved-investigation tooling
- Reads have no pagination yet — assumes admin UI doesn't exist

**Complexity to complete:** **M** for hash chain + Merkle anchor + SIEM export; **L** for the audit explorer UI.

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

No Kong / Envoy, no WAF, no quota table, no API key issuance, no per-client rate limit, no OpenAPI doc generation (NestJS Swagger module not installed). The Next.js BFF is the closest thing to a gateway today.

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
| **Status** | NOT STARTED |
| **Compl. %** | 5 % (seed script + minimal `tenants` lookup) |

No UI for users / groups / roles / policies / tenants / feature flags / quotas / SSO config / SMTP config. Sidebar reserves "Administration" but it's disabled. Step-up auth (re-auth + MFA + destructive-action confirmation token) all absent. **Complexity: L.**

---

## 3.20 Monitoring & Observability (deep dive §14)

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 5 % |

NestJS logger writes to stdout; not JSON-enforced; no Prometheus / Loki / Tempo / Grafana / Alertmanager / Grafana OnCall. `health` controller is liveness-only with no dependency probes.

**Complexity:** **L** for OTEL + Prometheus + Loki + Grafana on a single host; **XL** at proper SRE quality.

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
| **Status** | NOT STARTED |

No `incidents` table, no severity classification, no roles (Commander/Comms/Ops), no status-page integration, no post-mortem template, no MTTD/MTTR analytics. **Complexity: L–XL.**

---

## Cross-cutting infrastructure trackers

### Event plane (NATS JetStream)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.6, §3.13, §3.20, §3.22, §3.26, §3.27, audit projection, geofence-trigger, etc. |
| Complexity | M to deploy + integrate first publisher; L for outbox + idempotent consumers + dead-letter |

### Analytics plane (ClickHouse)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.5, all dashboards, audit-archive, position-history queries |
| Complexity | L to deploy single-shard; XL for properly sharded/replicated cluster + materialised views per dashboard |

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
| Status | NOT STARTED |
| Blocks | §3.11, §3.22, §3.26 |
| Complexity | L (gateway + Redis pub/sub fan-out) |

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
| Status | NOT STARTED |
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
| 3.13 Notifications | NOT STARTED | 0 % | L |
| 3.14 Search | NOT STARTED | 3 % | XL |
| 3.15 Audit | PARTIAL | 45 % | M |
| 3.16 Wiki | NOT STARTED | 0 % | XL |
| 3.17 API Gateway | NOT STARTED | 0 % | L → XL |
| 3.18 AI Readiness | NOT STARTED | 2 % | XXL |
| 3.19 Admin Panel | NOT STARTED | 5 % | L |
| 3.20 Observability | NOT STARTED | 5 % | L → XL |
| 3.21 Import/Export | NOT STARTED | 0 % | XL |
| 3.22 Realtime Collab | NOT STARTED | 0 % | XL |
| 3.23 Cases | NOT STARTED | 0 % | L → XL |
| 3.24 Media | NOT STARTED | 0 % | L |
| 3.25 Geo Analytics | NOT STARTED | 0 % | sub-scope of 3.4 |
| 3.26 Ops Monitoring | NOT STARTED | 0 % | XL |
| 3.27 Incidents | NOT STARTED | 0 % | L → XL |

**Aggregate completion against ToR §3 surface:** ~**6 %**.
This is **the right number for a Phase-1 foundation that has not yet entered Phase 2**.

See [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) for sequencing of remaining work.
