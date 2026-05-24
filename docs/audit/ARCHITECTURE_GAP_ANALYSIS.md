# ARCHITECTURE GAP ANALYSIS
## Delta between ToR blueprint and current implementation

**Reference architecture:** ToR §2.2 — seven concentric rings.
**Audit date:** 2026-05-24.

This document is organised by the seven architectural rings in ToR §2.2.
Each ring section lists:
1. **Target** — what the ToR describes.
2. **Today** — what exists in the repo.
3. **Gap** — what is missing or weak.
4. **Severity** — Critical / High / Medium / Low.
5. **Migration plan** — how to close it.

---

## Ring 0 — Identity & Trust

### Target

OIDC-compliant authorization server (Keycloak or `oidc-provider`-backed), RS256 JWT with 90-day key rotation + JWKS, refresh-token rotation with replay detection, MFA (TOTP + WebAuthn + backup codes), session lifecycle, device registry, revocation propagated via NATS, RBAC + ABAC (OPA/Rego) policy decision points, tenant context as a Day-0 architectural primitive, audit on every authentication and authorization decision.

### Today

- HS256 JWT issued by the same NestJS process that verifies it (correct choice per ADR-0002 until a second service exists).
- `sessions` table backs every access JWT (`sid` claim → lookup at middleware).
- Refresh-token rotation **with family-burn on replay** (production-grade per ADR-0003).
- argon2id with constant-time dummy-verify path.
- Tenant context via ALS, populated by middleware, enforced at the database via RLS + `cmc_app` role + `FORCE ROW LEVEL SECURITY`.
- Audit on every login outcome (success, failure, denied) with durable failure-path persistence.

### Gap

| Item | Severity |
|---|---|
| No MFA (TOTP, WebAuthn, backup codes) | **High** |
| No rate limiting on `/auth/login` and `/auth/refresh` | **Critical** for any public deployment |
| No OIDC server / no JWKS endpoint | **Medium** (only matters when a second service or partner needs to verify tokens) |
| No SAML 2.0 / SCIM | **Medium** |
| No RBAC at all (no roles, no permissions) | **Critical** (within-tenant access control absent) |
| No ABAC / OPA | **High** |
| No revocation broadcast | Low today (single instance), High at scale |
| No anomaly detection (impossible travel, new device) | Medium |
| No DPoP / token binding | Low |
| No password reset flow | Medium |
| No tenant picker for ambiguous emails | Low |

### Migration plan

1. **Now (Critical blockers):** add Redis-backed sliding-window rate limiter as a NestJS guard on auth endpoints. Add MFA tables (`user_mfa_methods`) + TOTP enrolment endpoint + WebAuthn enrolment endpoint + backup-codes table. Add RBAC tables (`roles`, `permissions`, `role_permissions`, `user_roles`) + `@Authorize('document:read')` decorator + a guard that resolves permissions via the active tenant context.
2. **Next:** introduce OPA sidecar for ABAC; start with a single policy (`document_read_with_classification`) and grow.
3. **Later:** OIDC server adoption (Keycloak) when external SSO is required.

---

## Ring 1 — Domain Services

### Target

Business modules — GIS, Documents, Workflow, Chat, Wiki, Notifications, Cases, Incidents, Operational Monitoring, Knowledge Base, Search, Media, Analytics, Admin — each as a NestJS module with module-owned data, stable contracts, own migrations, own tests, extractable to a standalone service without refactor.

### Today

**Domain modules implemented:**
- Documents (upload init → finalize → list → get → signed-download → soft-delete) — this is the **template** ADR-0004 establishes.

**Domain modules absent:** the remaining 19 of the §3 product modules.

The infrastructure modules (auth, audit, tenants, users, storage, database, health, tenant-context) are also present, complete enough to support Documents but **not complete enough to support the other modules** without extension (no RBAC, no events, no observability, no rate-limit).

### Gap

| Item | Severity |
|---|---|
| 19 of 20 product modules not started | **Critical** for ToR scope; **non-blocking** for the current solo-dev phase |
| Documents module lacks ECM features (folders, versions, retention, classification, signatures) | **High** for Phase-3 |
| No event publication — each module mutation is internal-only | **Critical** for any cross-module reaction |
| No idempotency keys on POST handlers | **Medium** |
| No GraphQL on the BFF | **Low** (REST works) |

### Migration plan

1. Extract the Documents module's shape into a documented **module template**: `(module)/{controller, service, dto, schema, migration, rls-policy-migration, e2e-spec}`.
2. Decide the next domain module (incidents → cases → GIS layers are the natural order given the dashboard mock) and stand it up using the template.
3. Add outbox + first event publisher when the second module needs to react to the first (e.g., incident-created → notification-dispatch).

---

## Ring 2 — Data Plane

### Target

- **OLTP:** PostgreSQL 16+ with PostGIS, Patroni HA cluster, PgBouncer, streaming + logical replication.
- **OLAP:** ClickHouse sharded/replicated, projections, materialised views, distributed tables, ZooKeeper/CH-Keeper.
- **Cache / state:** Redis Cluster.
- **Search:** OpenSearch with k-NN plugin.
- **Object storage:** S3-compatible (MinIO on-prem, AWS S3 cloud).
- **Vector:** Qdrant or pgvector for low volume.
- **Audit (immutable):** ClickHouse append-only + S3 archival + Merkle anchor.
- **Time-series:** TimescaleDB or ClickHouse.
- **Event log:** NATS JetStream / Kafka.
- **Multi-tenancy:** shared-schema RLS + separate-schema per high-isolation tenant + dedicated-DB option for sovereign tenants.
- **Backups:** pgBackRest / wal-g + scheduled CH backups + S3 versioning + cross-region replication.
- **Partitioning:** declarative by tenant_id (hash) or time (range) for large tables.
- **Retention + cryptographic erasure** (per-tenant DEK).

### Today

| Datastore | State |
|---|---|
| Postgres 16 + PostGIS + pgvector + pg_trgm + ltree + btree_gin + btree_gist + pgcrypto | ✅ deployed (compose) |
| Redis 7 password-protected, AOF persistence | 🟡 deployed, **unused by application code** |
| MinIO single-node S3 | ✅ |
| ClickHouse | ❌ |
| OpenSearch | ❌ |
| Qdrant | ❌ |
| NATS JetStream / Kafka | ❌ |
| TimescaleDB | ❌ |
| pgBackRest / wal-g / Patroni / PgBouncer | ❌ |
| Multi-tenancy mode | shared-schema RLS only |
| Partitioning | none |
| Per-tenant DEK | none |

### Gap

| Item | Severity |
|---|---|
| Single Postgres instance, no HA, no replicas | **High** for prod; acceptable per ADR-0001 for current scope |
| No backups | **Critical** before any non-dev data lands |
| No analytical store → any analytics will scan OLTP | **High** for Phase-2 dashboard work |
| No event log → no projection rebuilds | **Critical** for the event-driven plane |
| Redis present but unused → cache opportunities being left on the table (session-active lookup is one) | **Medium** |
| No PgBouncer → connection-pool exhaustion at ~200 concurrent | **Medium** |
| No partitioning → large tables (audit_log at scale) will degrade | **Low** today; **High** at scale |
| No tenant-cryptographic isolation | **High** for regulated tenants |
| No data-residency or sovereign-deploy story | **Medium** |

### Migration plan

1. **Now:** wire Redis for session-active cache (TTL = access-token lifetime) and rate-limiting state.
2. **Now:** add pgBackRest cron + nightly pg_dump to S3 for any non-dev deployment.
3. **Phase 2:** stand up ClickHouse single-shard; build the audit-archive consumer.
4. **Phase 2:** stand up NATS JetStream + outbox pattern.
5. **Phase 2:** PgBouncer in transaction-pooling mode in front of Postgres.
6. **Phase 3:** OpenSearch for full-text + permission-aware indexing.
7. **Phase 4+:** Patroni HA cluster, multi-region replication, per-tenant DEK via Vault Transit.

---

## Ring 3 — Event Plane

### Target

NATS JetStream (preferred) or Kafka. AsyncAPI + JSON Schema registry. Outbox pattern atomic-with-state-change. Idempotent consumers maintaining `processed_events`. Delivery semantics: at-least-once + idempotent → effective exactly-once. Ordered per aggregate. Every event carries `trace_id`, `causation_id`, `correlation_id`.

### Today

**Entire ring missing.** No broker, no outbox table, no schema registry, no consumers, no event-id traceability. The `audit_log` table is closest analogue but is not a substitute (one-way write, no replay, no subject pattern matching).

### Gap

**Critical structural gap.** Every ToR module that the document describes as "emits …" or "consumes …" is **blocked** on this ring. Real-time UI (§7.4), notifications (§3.13 → §3.27), audit projection (§3.15 → ClickHouse), geofence-trigger (§4.7), cross-instance presence (§7.3), session revocation broadcast (§3.1), and the entire collaboration plane (§3.22) all depend on the event plane existing.

### Migration plan

1. Deploy NATS JetStream single-node alongside Postgres + Redis + MinIO in compose.
2. Add `outbox` table (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, published_at, tenant_id).
3. Write event-publish in the same transaction as state-change; a relay process (NestJS worker) tail-reads the outbox and publishes.
4. Add `processed_events` table for consumers + idempotency-by-event-id pattern.
5. Wire the first consumer: audit projection to ClickHouse (once CH is up) **or** intra-process WebSocket fan-out (no CH yet).
6. Standardise the event envelope: `{event_id, event_type, version, tenant_id, occurred_at, trace_id, causation_id, correlation_id, payload}`.

---

## Ring 4 — Realtime Plane

### Target

Dedicated NestJS WebSocket gateway (separate process from REST API for independent scaling). JSON protocol over WS. JWT auth on upgrade + transparent refresh. Subscriptions to `tenant:X:domain:Y:resource:Z`. Heartbeat / reconnect with last-seen offset replay. Redis-backed presence with sorted sets. Cross-instance fanout via Redis Pub/Sub or NATS. Yjs CRDT for collab. WebRTC SFU via LiveKit. coturn for TURN/STUN.

### Today

**Entire ring missing.** No `@nestjs/websockets`, no Yjs, no LiveKit, no coturn.

### Gap

**Critical structural gap** for Phase-2 dashboards (live KPIs), Phase-3 collab (Wiki, dashboard editing), Phase-4 chat / video, Phase-4 operational monitoring center.

### Migration plan

1. Phase 2: WebSocket gateway as a separate NestJS service, sharing the same Postgres + Redis. Wire to consume from NATS and fan out to subscribed clients with subject-pattern authorization.
2. Phase 3: Yjs + WebSocket provider, persistence-checkpoint to Postgres.
3. Phase 4: LiveKit + coturn for video/audio.

---

## Ring 5 — Edge Plane

### Target

- API Gateway (Kong / Envoy) — TLS termination, mTLS for partners, OAuth2 client credentials, per-client/per-endpoint/per-tenant rate limiting, request/response transformation, routing, API versioning, WAF (OWASP CRS), OpenAPI 3.1 schema validation, API analytics + quota.
- BFF in Next.js for frontend-specific orchestration.
- CDN at the edge for static assets and tiles.
- WAF.

### Today

- BFF in Next.js ✅ (working Server Components + Server Actions + Auth.js cookie-wraps-bearer pattern).
- No Kong / Envoy.
- No CDN.
- No WAF.
- No quota.
- No API key issuance for external clients.
- No OpenAPI generation (NestJS Swagger module not installed).
- TLS: deferred to a Caddy add-at-deploy step (ADR-0001).
- Versioning: no `/v1` prefix, no Sunset headers.

### Gap

| Item | Severity |
|---|---|
| No rate limiting at the edge | **Critical** for any public deploy |
| No WAF | **High** |
| No external API path (keys, quota, analytics) | **Low** today; **High** in Phase-3 |
| No OpenAPI generation | **Medium** (without it SDKs can't be generated from contract) |
| No `/v1` versioning | **Medium** (cheaper to introduce before consumers exist) |
| Reverse proxy / TLS deferred | **High** before first deploy |

### Migration plan

1. **Now:** add `/v1` path prefix to API routes and an interceptor that emits `Sunset` headers on deprecated routes.
2. **Now:** install `@nestjs/swagger` + register decorators; serve OpenAPI at `/v1/openapi.json` + a Redoc/Swagger UI page (admin only).
3. **Now:** add a NestJS `@Throttle` rate-limit guard backed by Redis. Apply to `/auth/login`, `/auth/refresh`, generic POSTs.
4. **At deploy:** Caddy + automatic Let's Encrypt + WAF (CrowdSec Caddy module is a good open-source fit).
5. **Phase 2:** Kong or Envoy in front of the API when external partners need API keys + quota.

---

## Ring 6 — Observability Plane

### Target

OpenTelemetry instrumentation across all services. Prometheus + Thanos. Loki for logs. Tempo / Jaeger for traces. Grafana OSS for dashboards. Alertmanager → internal Notification System (§3.13) with self-hosted on-call scheduling (Grafana OnCall). SIEM forwarder via Vector / Fluent Bit emitting Syslog RFC 5424 + CEF. Wazuh or OpenSearch Security Analytics for internal SIEM.

### Today

**Entire ring missing.** NestJS Logger writes to stdout (text format, not JSON). No metrics endpoint. No tracing SDK. No log aggregation. No alerting.

The `audit_log.trace_id` / `audit_log.request_id` columns exist but nothing populates them.

### Gap

**Critical for operations.** A system you cannot observe is a system you cannot run. ToR §20.1 principle 7 ("Untraced is unfinished") is currently violated for everything.

### Migration plan

1. **Now:** structured JSON logging (NestJS supports a custom logger; pino is the natural choice). Inject `request_id` (UUID per request) via middleware and attach to logger context.
2. **Now:** OTEL SDK auto-instrumentation for HTTP, Postgres, S3. Emit traces to a single-instance Tempo. Populate `trace_id` on audit-log rows.
3. **Now:** Prometheus client + `/metrics` endpoint. RED metrics per route. Cluster RED for the DB.
4. **Soon:** deploy Prometheus + Grafana + Loki + Tempo via compose addendum (`infra/observability-compose.yml`).
5. **Soon:** Alertmanager with one starter rule (5xx ratio > 1 % over 5 min); route via webhook to a Slack/Telegram channel until the in-platform Notification system exists.
6. **Soon:** synthetic monitoring — a 5-minute curl-loop check of the login flow from an external host (the simplest CI-driven option).

---

## Cross-cutting principles vs current state

ToR §2.3 enumerates eight core architectural principles. State vs intent:

| Principle | Intent | State today | Gap severity |
|---|---|---|---|
| **Event-first** | Every domain mutation produces a domain event; events are first-class | No events | **Critical** structural |
| **Tenant-first** | Every query, cache key, log entry, event carries tenant context; cross-tenant impossible by construction | Achieved at DB layer | **Met** |
| **Identity-anchored** | No anonymous internal calls; service-to-service via mTLS or short-lived JWT | Single service, internal calls are intra-process — moot | **Pre-emergent** (not yet relevant) |
| **Read/write separation** | OLTP for state, OLAP for analytics, Search for discovery, Cache for hot reads | OLTP only; cache deployed but unused | **High** |
| **Idempotent by default** | All command handlers idempotent; all event consumers tolerate redelivery | Document finalize is idempotent; others not exercised because no retries today | **Medium** |
| **Schema-explicit** | Every API, event, table change versioned + schema-validated | Zod contracts cover every API surface; no event schemas (no events); no API version prefix | **Medium** |
| **Observable by construction** | No service ships without metrics, traces, structured logs, health endpoints | Liveness health only; logs to stdout, not JSON; no metrics, no traces | **Critical** |
| **Failure-isolated** | Module failure must not cascade; circuit breakers, bulkheads, timeouts at every external boundary | Single-process; no circuit breakers | **Medium** today (no external services to fail); **Critical** as soon as the platform splits |

---

## Anti-patterns checklist (ToR §20.2)

ToR §20.2 enumerates anti-patterns to avoid. Audit-time verdict on each:

| Anti-pattern | Present? |
|---|---|
| Premature microservice decomposition | No — explicitly modular monolith |
| Database as integration mechanism | No |
| Distributed transactions across modules | No (no cross-module mutation paths exist yet) |
| Synchronous A→B→C→D chains | No (no internal chains exist) |
| Shared mutable state via cache | No (cache unused) |
| Tenant ID via header trust | No — derived from validated token claim |
| Bypassed RLS for performance | No — `runPrivileged` is documented + audit-trail-worthy |
| AI as opaque side channel | N/A (no AI) |
| "Observability later" | **Yes, present** — flagged as the most expensive of these |
| "Tests later" | No — CI + e2e exist from the first commit on `main` |
| Custom auth | No — uses Auth.js + standard JWT + argon2; only the API JWT signing is in-house, which is acceptable per ADR-0002's rationale |
| Premature i18n shortcuts | **Yes, present** — UI is hardcoded English (and embeds Tajikistan-specific copy). i18n decision deferred |

---

## Final gap-analysis verdict

The codebase is **architecturally correct for Phase 1** of the ToR and **structurally absent on Rings 3, 4, 6** (Event, Realtime, Observability). The two rings where the platform must absolutely not have shortcuts — **Identity & Trust (Ring 0)** and **the OLTP slice of the Data Plane (Ring 2)** — are well-built. That's the right trade-off for a foundation.

The path forward is **not refactor — it is extension.** Every existing module's shape (RLS migration → service via `tenantDb` → controller → contract → Server Action) is a template that the next 19 modules can be built against without re-architecting any of the substrate.

The single decision that **must** happen before the next domain module:
- **Add RBAC** (roles + permissions + a guard), or commit to "tenant is the only access boundary, and that is acceptable for the Tajikistan-CMC deployment because every authenticated user is staff."

That decision then sets up everything else: whose data, which dashboards, which workflows, who can revoke whom — all hang on it.
