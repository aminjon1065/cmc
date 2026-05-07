# ENTERPRISE OPERATIONAL INTELLIGENCE PLATFORM
## Technical Requirements Document & System Design Blueprint

**Document Classification:** Architecture Blueprint / Technical Specification
**Version:** 1.0
**Document Type:** System Design Specification (СДС) / Техническое Задание
**Audience:** CTO, Chief Architect, Architecture Review Board, Engineering Leadership, Procurement Committee

---

## 1. EXECUTIVE SUMMARY

### 1.1 Platform Mission

The platform is a **Unified Enterprise Operational Intelligence Ecosystem (UEOIE)** — a horizontally integrated digital backbone that consolidates analytical decision support, geospatial intelligence, document lifecycle management, real-time collaboration, structured workflow orchestration, and operational monitoring within a single coherent architectural envelope.

The platform's mission is to eliminate the fragmentation of enterprise digital infrastructure by replacing the conventional patchwork of point solutions (BI tool + GIS suite + ECM + chat tool + ticketing system + video conferencing + custom dashboards) with a single governed, observable, secure, and AI-ready operating environment for organizations whose decision velocity depends on the convergence of spatial, temporal, transactional, and human-collaborative data streams.

### 1.2 Strategic Goals

| Goal | Description | Measurable Outcome |
|---|---|---|
| **Operational Convergence** | Replace 6–12 disparate enterprise tools with a unified platform | ≥70% reduction in inter-system integration surface |
| **Decision Latency Reduction** | Move from batch-oriented BI to event-driven intelligence | Sub-second propagation from event to operational dashboard |
| **Spatial-Temporal Fusion** | First-class treatment of geospatial data alongside transactional and analytical workloads | Native PostGIS + ClickHouse co-query capability |
| **Compliance & Auditability** | Government-grade auditability, immutable trail, tenant isolation | Full SOC2/ISO27001/GDPR alignment, immutable WORM audit log |
| **AI Readiness** | Architecture pre-engineered for LLM, RAG, vector retrieval, semantic search | Vector index + embedding pipeline as Day-0 infrastructure primitive |
| **Horizontal Scalability** | From 100 → 100,000 concurrent users without architectural rewrite | Stateless service tier, partitioned data tier, federated event bus |

### 1.3 Business Objectives

- Provide a **single pane of glass** for cross-domain operational decision-making.
- Enable **vertical integration** between strategic dashboards, tactical workflows, and operational ground truth (GIS, IoT, telemetry).
- Reduce total cost of ownership through consolidation of licensing, infrastructure, and support overhead.
- Establish a **digital sovereignty posture**: on-premise, hybrid-cloud, or sovereign-cloud deployable without architectural deviation.
- Provide **regulatory-grade evidentiary capability** — every action, change, decision, and access event is forensically reconstructable.

### 1.4 Enterprise & Government Applicability

The platform targets organizational classes where the synthesis of spatial, transactional, and collaborative data is a core operational requirement:

- **Public sector**: ministries, municipalities, regulators, national infrastructure operators.
- **Critical infrastructure**: utilities (water, gas, electricity), transportation, telecommunications.
- **Financial services**: regional and central banks, financial intelligence units, large corporate treasury operations.
- **Defense & security-adjacent**: civil defense, emergency management, border and customs operations.
- **Industrial conglomerates**: oil & gas, mining, logistics, port and airport operations.
- **Healthcare networks**: regional health systems requiring patient flow + spatial epidemiology + document lifecycle.

### 1.5 Operational Goals

1. **Continuous availability** — 99.95% baseline SLA, 99.99% target on critical paths (auth, audit, alerting).
2. **Recoverability** — RPO ≤ 5 minutes, RTO ≤ 30 minutes for tier-1 modules.
3. **Forensic transparency** — every state mutation traceable to identity, timestamp, IP, device, and authorization decision.
4. **Tenant strict isolation** — cryptographic separation of tenant data domains; no cross-tenant query path.
5. **Zero-trust posture** — no implicit network trust; every request authenticated and authorized at boundary and at service.

### 1.6 Long-Term Scalability Vision

The platform is architected to traverse three scale horizons without architectural rewrite:

- **Horizon 1 (Departmental, 0–18 months):** 10²–10³ users, 10⁶ records, single region.
- **Horizon 2 (Enterprise, 18–36 months):** 10⁴ users, 10⁸ records, multi-region active-passive.
- **Horizon 3 (National/Federated, 36+ months):** 10⁵ users, 10¹⁰ records, multi-region active-active, federated tenants, sovereign deployments.

Architectural decisions in this document are evaluated against Horizon 3 to prevent "second-system rewrite" debt.

---

## 2. SYSTEM OVERVIEW

### 2.1 Platform Concept

The platform is structured as a **modular monolith evolving toward a domain-bounded distributed system**. This is a deliberate architectural posture: it begins as a monolith for development velocity and operational simplicity, with explicit module boundaries (NestJS modules with no shared state, communicating via in-process event bus that mirrors the eventual inter-service contract). When a module's load profile, deployment cadence, or team ownership diverges from the core, it is extracted with zero contract change.

### 2.2 Ecosystem Architecture

The system is organized as **seven concentric architectural rings**:

1. **Ring 0 — Identity & Trust:** IAM, RBAC/ABAC, tenant context, audit. Every request must traverse this ring.
2. **Ring 1 — Domain Services:** business modules (GIS, Documents, Workflow, Chat, etc.).
3. **Ring 2 — Data Plane:** PostgreSQL (OLTP), ClickHouse (OLAP), Redis (cache/state), OpenSearch (full-text), Object Storage (blobs), Vector DB (embeddings).
4. **Ring 3 — Event Plane:** NATS / Kafka — the platform's nervous system. Every state change emits an event; every cross-module reaction subscribes.
5. **Ring 4 — Realtime Plane:** WebSocket gateway, presence service, collaborative state sync, WebRTC SFU.
6. **Ring 5 — Edge Plane:** API Gateway, BFF (Backend-for-Frontend), CDN, WAF, rate limiting.
7. **Ring 6 — Observability Plane:** OpenTelemetry, Prometheus, Loki, Tempo, Grafana, SIEM forwarder.

### 2.3 Core Architectural Principles

| Principle | Implication |
|---|---|
| **Event-first** | Every domain mutation produces a domain event; events are first-class citizens, not derived artifacts |
| **Tenant-first** | Every query, cache key, log entry, and event carries tenant context; cross-tenant access is impossible by construction |
| **Identity-anchored** | No anonymous internal calls; service-to-service uses signed mTLS or short-lived JWT |
| **Read/write separation** | OLTP for state of record, OLAP for analytics, Search for discovery, Cache for hot reads |
| **Idempotent by default** | All command handlers are idempotent; all event consumers tolerate redelivery |
| **Schema-explicit** | All inter-service contracts (events, APIs, DB tables) versioned and schema-validated |
| **Observable by construction** | No service ships without metrics, traces, structured logs, and health endpoints |
| **Failure-isolated** | Module failure must not cascade; circuit breakers, bulkheads, and timeouts at every external boundary |

### 2.4 Modular Architecture Philosophy

The platform follows **Domain-Driven Design (DDD) bounded contexts** mapped to NestJS feature modules. Each module:

- Owns its data (no foreign keys across module boundaries; cross-module references are by ID only, resolved via API or event projection).
- Exposes a stable contract (REST + event schema).
- Has its own migrations, fixtures, and tests.
- Can be extracted into a standalone service without code refactor — only deployment topology changes.

### 2.5 Platform Responsibilities

The platform is responsible for:

- **Identity & authorization** for all human and machine actors.
- **Persistence & integrity** of all transactional, geospatial, analytical, and document data.
- **Eventing & orchestration** across modules and external systems.
- **Real-time collaboration & communication** (chat, presence, video, co-editing).
- **Discovery** (search, navigation, recommendations).
- **Observability & audit** of every action, decision, and system event.
- **Operational orchestration** (workflows, approvals, escalations, SLAs).
- **Spatial intelligence** (mapping, analytics, geofencing, routing).

The platform is **not** responsible for:

- Domain-specific calculation logic outside the listed modules (delegated to integration via API gateway).
- ERP/Finance core ledger (integrated with, not replaced).
- HRIS master data (integrated with, not replaced).

### 2.6 High-Level Workflow

A canonical end-to-end flow:

1. User authenticates via SSO (OIDC) → IAM issues short-lived access token + refresh token.
2. Frontend (Next.js) hits BFF → BFF validates token, attaches tenant context, forwards to NestJS service.
3. Service handles command → writes to PostgreSQL → emits domain event to NATS.
4. Event consumers in parallel: ClickHouse projector (for analytics), OpenSearch indexer, WebSocket broadcaster (realtime UI update), Audit logger (immutable WORM store), Notification dispatcher.
5. User's other open sessions receive realtime push; analytical dashboards reflect the change within sub-second latency; audit trail is hashed and chained.

### 2.7 Operational Model

The platform is operated under a **Site Reliability Engineering (SRE) discipline** with explicit SLOs, error budgets, on-call rotations, blameless post-mortems, and automated runbooks. Operations are defined as code (Terraform, Helm, Argo CD) with no manual production access except via audited break-glass procedures.

---

## 3. CORE PLATFORM MODULES

### 3.1 Identity & Access Management (IAM)

**Purpose:** Single source of identity, authentication, and federated trust for human users, service accounts, and external systems.

**Business logic:**
- User lifecycle (provision → activate → suspend → deprovision).
- Group membership, organizational hierarchy projection.
- Federation with external identity providers (SAML 2.0, OIDC, LDAP/AD).
- Service account / API key issuance with scoped permissions.

**Technical responsibilities:**
- OIDC-compliant authorization server (Keycloak or custom NestJS service backed by `oidc-provider`).
- JWT issuance (RS256, key rotation every 90 days, JWKS endpoint).
- Refresh token rotation with replay detection.
- MFA enforcement (TOTP, WebAuthn/FIDO2, backup codes).
- Session lifecycle, device registry, revocation propagation via NATS.

**Interactions:** Every other module depends on IAM for token validation. IAM publishes events (`user.created`, `user.suspended`, `mfa.enabled`) consumed by audit, notification, and projection services.

**APIs:**
- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/.well-known/openid-configuration`, `GET /auth/jwks.json`.
- Admin: `GET/POST/PATCH /users`, `GET/POST/PATCH /groups`, `POST /service-accounts`.

**Data flow:** Credentials → bcrypt/argon2 → user store (PostgreSQL). Token validation is stateless (JWT signature) with revocation list cached in Redis (bloom filter for fast negative check).

**Scalability:** Stateless authorization server; horizontally scaled. Token validation pushed to API gateway / sidecar to offload services.

**Security:** No password storage outside argon2id with per-tenant pepper. Refresh tokens hashed before storage. Brute-force protection via Redis-backed sliding-window rate limiter.

**Realtime:** Session invalidation propagated via NATS (`auth.session.revoked`) to all WebSocket gateways within 200ms.

**UX expectations:** SSO-first flow; MFA challenge inline; "trusted device" registration; account recovery via support ticket (no self-service email reset for high-trust tenants).

---

### 3.2 Multi-Tenancy

**Purpose:** Cryptographic and logical isolation of customer/department/agency data within a shared infrastructure footprint.

**Tenancy model:** Hybrid — **shared schema with row-level security (RLS)** for most modules, **separate schema per tenant** for high-isolation modules (Documents, GIS layers), **dedicated database per tenant** as a deployment option for sovereign or regulated tenants.

**Technical responsibilities:**
- Tenant context resolution from JWT claim (`tenant_id`) injected into every request.
- PostgreSQL RLS policies on every table (`USING (tenant_id = current_setting('app.tenant_id')::uuid)`).
- Tenant-scoped Redis namespacing (`tenant:{id}:cache:...`).
- Tenant-scoped OpenSearch indices (`docs-{tenant_id}-{yyyy.mm}`).
- Per-tenant encryption keys (envelope encryption via KMS / Vault Transit).

**Interactions:** Every module receives `TenantContext` via a NestJS `RequestContext` injection. Cross-tenant access is structurally impossible — there is no API path, query path, or event path that lacks tenant context.

**Scalability:** Tenant sharding plan: when a tenant exceeds threshold (e.g., 500GB or 1000 concurrent users), it is migrated to dedicated infrastructure. Migration tooling is part of Day-1 deliverables.

**Security:** Per-tenant encryption keys; per-tenant audit segregation; per-tenant rate limits; per-tenant feature flags.

---

### 3.3 RBAC/ABAC Authorization

**Purpose:** Fine-grained, policy-driven authorization that scales from "users have roles" to "decisions depend on resource attributes, request context, time, location, and consent."

**Model:** Hybrid RBAC + ABAC.

- **RBAC layer:** Roles (e.g., `analyst`, `gis_editor`, `workflow_approver`) bundle permissions (e.g., `dashboard:read`, `layer:edit`, `workflow:approve`).
- **ABAC layer:** Policies expressed in **Rego (Open Policy Agent)** evaluated for non-trivial decisions (e.g., "approver may approve only if amount < their limit AND not own creator").

**Technical responsibilities:**
- Policy Decision Point (PDP) — OPA sidecar or central PDP service with policy bundle distribution.
- Policy Enforcement Point (PEP) — NestJS guard (`@AuthorizeWith('document.read')`) that calls PDP.
- Policy Information Point (PIP) — fetches resource attributes (e.g., document classification, owner, tags) for the decision.
- Decision caching with strict invalidation on policy or attribute change.

**APIs:** Internal `POST /authz/decide` (input: subject, action, resource, context; output: allow/deny + obligations).

**Data flow:** Request → Guard → PDP → PIP (cache → DB) → decision → audit log entry (every deny is logged; allows are sampled for performance).

**Performance:** P99 decision latency < 5ms via in-memory policy + Redis-backed attribute cache with TTL and event-driven invalidation.

---

### 3.4 GIS & Geospatial Intelligence

(See **Section 4** for the deep dive. Summary here.)

**Purpose:** First-class spatial data citizen — not bolt-on mapping, but native spatial reasoning across all modules.

**Capabilities:**
- Layer management (vector, raster, tiled, live).
- Map composition, styling, and publishing.
- Spatial queries (within, intersects, distance, containment, buffer).
- Geofencing with realtime trigger evaluation.
- Routing, isochrones, gravity analysis.
- Heatmaps, clustering, choropleth.
- Realtime asset tracking (vehicles, personnel, IoT).

**Data:** PostGIS for authoritative spatial state; tile cache (vector tiles) served via tile server (e.g., `pg_tileserv` or custom NestJS service); MapLibre GL on the frontend.

---

### 3.5 Analytics & Reporting

**Purpose:** From operational metrics ("what is happening now") to strategic analytics ("what changed last quarter and why") on a single substrate.

**Architecture:** **Lambda-style separation** between OLTP (PostgreSQL) and OLAP (ClickHouse), bridged by event-driven projections.

**Capabilities:**
- Pre-built operational dashboards (per module).
- User-built dashboards via the Dashboard Builder.
- Ad-hoc query (SQL-like DSL on top of ClickHouse).
- Scheduled reports (PDF/XLSX export, email delivery).
- Time-series, cohort, funnel, retention analysis.
- Cross-module joins (e.g., "documents created in workflows that touched assets in geofence X").

**Data flow:** Domain events → Kafka/NATS → ClickHouse projector (using `kafka-engine` table or NestJS consumer with batch insert) → materialized views → dashboard queries.

**Scalability:** ClickHouse columnar engine handles billions of rows; aggregating MVs collapse to second-resolution aggregates for dashboard hot paths; pre-aggregation strategy defined per dashboard.

**Performance:** Dashboard P95 < 1.5s for queries up to 1B rows via materialized views + projections + skip indexes.

---

### 3.6 Realtime Event System

**Purpose:** The platform's central nervous system — every domain change, every UI update, every cross-module reaction flows through here.

**Architecture:**
- **Event bus:** **NATS JetStream** (preferred for operational simplicity and lightweight footprint up to ~1M msg/s) OR **Apache Kafka** (preferred when retention >7 days, exactly-once semantics, or external integration with Kafka-native tools is required). The decision matrix is documented in §15.
- **Event schema registry:** AsyncAPI + JSON Schema versioned per event type.
- **Outbox pattern:** Domain events written to `outbox` table in same transaction as state mutation; relay process ships to broker. Guarantees at-least-once delivery without 2PC.
- **Idempotent consumers:** Every consumer maintains a `processed_events` table or Redis set keyed by `(event_id, consumer_name)`.

**Delivery semantics:**
- At-least-once for domain events.
- Exactly-once for idempotent operations (via consumer-side dedup).
- Ordered per aggregate (partition key = aggregate ID).

**Observability:** Every event carries `trace_id`, `causation_id`, `correlation_id` for full distributed tracing.

---

### 3.7 Dashboard Builder

**Purpose:** Empower analysts to compose dashboards without engineering involvement, while preserving governance.

**Capabilities:**
- Drag-and-drop widget grid (react-grid-layout).
- Widget catalog: time-series chart, KPI card, table, geo-map, heatmap, funnel, custom SQL widget (governed).
- Datasource binding to ClickHouse (read-only views), PostgreSQL views, or saved queries.
- Parameters, filters, drill-throughs, cross-filtering.
- Dashboard publishing, versioning, sharing with RBAC.
- Snapshot export (PDF, PNG) and scheduled email distribution.

**Technical:** Dashboard definitions stored as JSON documents (PostgreSQL `jsonb`); rendered via a stable schema interpreted by the frontend; widget rendering is React components selected by `widget.type`.

**Scalability:** Heavy queries pre-materialized; dashboard rendering does not issue raw SQL — it issues parameterized prepared queries vetted by a SQL safety layer (no user-supplied DDL/DML).

---

### 3.8 File Management System

(See **Section 9** for deep dive.)

**Summary:** Hierarchical folder model with permission inheritance, versioning, large-file resumable upload (tus.io protocol), preview generation pipeline, encryption at rest, retention policies, and full-text indexing.

---

### 3.9 Enterprise Document Management (ECM/EDMS)

**Purpose:** Beyond file storage — structured document lifecycle, classification, metadata, retention, and legal-hold capability.

**Capabilities:**
- Document types with structured metadata schemas (e.g., contract, decree, regulation, report).
- Lifecycle states (draft → review → approved → published → archived).
- Versioning with diff (textual and structural).
- Classification and tagging (manual + AI-assisted via embedding similarity).
- Legal hold (suspends retention deletion, immutable until released).
- Records management compliance (e.g., DoD 5015.2-style records declaration).
- Digital signatures (eIDAS-aligned, PKCS#7 detached signatures, optional integration with national PKI).

**Data:** PostgreSQL for metadata; object storage (S3-compatible: MinIO on-prem, AWS S3 / Azure Blob in cloud) for content; OpenSearch for full-text.

---

### 3.10 Workflow / BPM Engine

(See **Section 10** for deep dive.)

**Summary:** Embedded self-hosted workflow engine driven by **Temporal (open source)** for durable, code-defined workflows, with **Camunda 7 Community Edition (Apache 2.0)** as an alternative when BPMN visual modeling is required. Supports approvals, parallel branches, escalation, SLAs, compensation, signal/wait patterns. No managed-service or per-execution-billed runtimes.

---

### 3.11 Chat & Messaging

**Purpose:** Operational communication channel embedded with platform context — discuss a workflow case, an asset on the map, a document, a dashboard anomaly.

**Capabilities:**
- 1:1 DM, group channels, threaded replies.
- Message types: text, file, image, voice clip, system event ("workflow advanced to approval"), platform object embed (link to dashboard widget, map feature, document version).
- Mentions, reactions, formatting (Markdown subset), code blocks.
- Message editing/deletion with audit trail (deleted messages remain in audit, hidden from UI).
- Read receipts, typing indicators, presence.
- E2E encryption optional for high-trust channels (via libsignal-style protocol; default is server-side encrypted but server-readable for compliance).

**Technical:**
- Messages persisted to PostgreSQL (recent) + ClickHouse (analytics + cold storage).
- Realtime delivery via WebSocket fan-out service with Redis Pub/Sub for cross-instance.
- Message ordering: hybrid logical clock per channel.
- Search: OpenSearch index per channel-month.

**Scalability:** Channel sharding by `channel_id` hash; WebSocket gateway horizontally scaled; cross-gateway delivery via Redis Streams.

---

### 3.12 Video Conferencing

(See **Section 8** for deep dive.)

**Summary:** WebRTC-based with SFU topology via **LiveKit** (preferred — open source, Kubernetes-native, scalable, modern) OR **Jitsi Videobridge** (alternative for fully self-hosted, BSD-friendly licensing). TURN/STUN via **coturn**. Recording via egress service with object storage upload.

---

### 3.13 Notification System

**Purpose:** Multi-channel, user-preference-aware, reliable delivery of platform-generated notifications.

**Channels:** In-platform (bell icon + dedicated panel), email (self-hosted SMTP — Postfix/Postal/Haraka), web push (W3C Web Push protocol over self-hosted VAPID), mobile push (self-hosted via UnifiedPush or self-managed gateway), generic outbound webhook (for integration with any external system the tenant operates).

**Capabilities:**
- Per-user channel preferences.
- Per-notification-type routing (e.g., "P1 incidents → web push + email; document comments → email digest").
- Deduplication and bundling (digest at user-defined cadence).
- Quiet hours, timezone awareness.
- Delivery receipts and retry with exponential backoff.

**Technical:** NestJS notification module subscribes to NATS topics; templating via MJML (email) / Handlebars; outbound delivery workers per channel; dead-letter queue for failures. All delivery uses self-hosted infrastructure or open protocols — no per-message-billed third-party services.

---

### 3.14 Search Engine

**Purpose:** Federated search across documents, messages, dashboards, map features, workflow cases, users, and any indexable object.

**Architecture:** OpenSearch cluster with index-per-domain pattern. Cross-index search via federated query and result fusion (BM25 + semantic re-rank).

**Capabilities:**
- Keyword search (BM25).
- Semantic search (vector kNN via OpenSearch k-NN plugin or dedicated Qdrant/Milvus).
- Filters, facets, sort.
- Permission-aware (post-filter by ABAC at query time; for high-cardinality permissions, a "filter context" computed at indexing time using bitmap encoding of user-group access).
- Auto-complete, did-you-mean, query suggestions.
- Saved searches and search alerts.

**Scalability:** Sharding by tenant + time; rolling indices for time-series data; hot/warm/cold tier policy.

---

### 3.15 Audit & Activity Logging

**Purpose:** Forensic-grade record of every action and state change.

**Properties:**
- **Immutable:** WORM (write-once-read-many) storage; append-only ClickHouse table + cryptographic chain (each record's hash includes previous record's hash → tamper-evident).
- **Comprehensive:** Every authentication, authorization decision (denies always, allows sampled), data mutation (with before/after snapshot), administrative action, and security-relevant event.
- **Structured:** Schema enforced; queryable; exportable via open standards (Syslog RFC 5424, CEF, JSON over HTTP) for any conforming downstream system the tenant chooses to operate.
- **Tamper-evident:** Daily Merkle root anchored to external trust store (notary, blockchain, or airgapped store).

**Schema (core fields):**
```
event_id (UUID), tenant_id, actor_id, actor_type, action, resource_type,
resource_id, ip, user_agent, device_id, request_id, trace_id,
outcome, before_hash, after_hash, prev_event_hash, this_hash, ts
```

**Retention:** Configurable per tenant; minimum 7 years for regulated tenants; legal-hold suspends deletion.

---

### 3.16 Knowledge Base / Wiki

**Purpose:** Internal documentation, runbooks, policies, organizational knowledge — a living, searchable, version-controlled corpus.

**Capabilities:**
- Hierarchical spaces, pages, sub-pages.
- Block-based editor (similar to Notion), Markdown export/import.
- Inline embeds (dashboard, map, document, code block, diagrams via Mermaid/PlantUML).
- Version history, diff, restore.
- Comments and discussion threads.
- Page-level permissions.
- Templates.
- Tagging and cross-linking.

**Realtime collaboration:** Operational Transform (OT) or CRDT (Yjs preferred) for concurrent editing with presence cursors.

**Search:** First-class citizen of the federated search; semantic search enables "find pages about topic X" without exact keyword matches.

---

### 3.17 Integration Gateway / API Gateway

**Purpose:** Single ingress for all external API consumers; single egress for all outbound integrations.

**Capabilities:**
- TLS termination, mTLS for partner integrations.
- Authentication (OAuth2 client credentials, API keys, JWT bearer).
- Rate limiting (per client, per endpoint, per tenant; token bucket).
- Request/response transformation, header normalization.
- Routing to backend services.
- API versioning (`/v1/...`, `/v2/...` with sunset headers).
- WAF (web application firewall) — OWASP CRS rules.
- Schema validation (OpenAPI 3.1).
- API analytics and quota management.

**Implementation:** **Kong** or **Envoy** (with custom NestJS auth filter) at the edge; NestJS BFF behind the gateway for frontend-specific orchestration.

---

### 3.18 AI-Ready Architecture

(See **Section 16** for deep dive.)

**Summary:** Vector database (Qdrant or pgvector for low-volume, Milvus for billion-scale), embedding pipeline (event-driven), RAG framework, LLM gateway (provider-agnostic abstraction), prompt management, evaluation harness, and AI safety guardrails.

---

### 3.19 Administration Panel

**Purpose:** Privileged operational interface for tenant admins, platform admins, and security officers.

**Capabilities:**
- User and group management.
- Role and policy management.
- Tenant configuration and feature flags.
- Resource quota visibility (storage, compute, concurrent sessions — for capacity planning, not billing).
- Audit log explorer with saved investigations.
- System health dashboard (mirror of internal SRE view, redacted to admin-relevant signals).
- Bulk operations (bulk user import, bulk permission changes) with preview and rollback.
- Integration configuration (SSO, SMTP, webhook destinations).

**Security:** Admin actions require step-up authentication (re-auth + MFA challenge); destructive actions require a confirmation token; bulk operations are previewable and reversible within a configurable window.

---

### 3.20 Monitoring & Observability

(See **Section 14** for deep dive.)

**Summary:** OpenTelemetry instrumentation across all services; metrics in Prometheus + Thanos; logs in Loki; traces in Tempo or Jaeger; visualization in Grafana OSS; alerting via Alertmanager → internal on-call rotation (email + push + chat) with self-hosted on-call scheduling. Entire stack is open source and self-hosted.

---

### 3.21 Data Import/Export

**Purpose:** Move data into and out of the platform at scale, with governance.

**Capabilities:**
- Bulk import: CSV, Excel, JSON, GeoJSON, Shapefile, GeoPackage, KML.
- Streaming import: Kafka topics, S3 event-driven, JDBC sources via custom CDC.
- Export: query → file (CSV/Excel/Parquet/GeoJSON), scheduled or ad-hoc.
- Data sync: bidirectional with external systems (e.g., ERP master data) via configured connectors.
- Validation pipeline: schema validation, geometry validation, deduplication, transformation.
- Quarantine for invalid records with operator review queue.

**Implementation:** Workers based on BullMQ (Redis) for orchestration; large jobs partitioned and parallelized; progress reported via WebSocket to UI.

---

### 3.22 Realtime Collaboration

**Purpose:** Multiple users simultaneously editing/interacting with the same artifact (document, dashboard, map, workflow diagram, wiki page) without conflicts.

**Mechanism:** **CRDTs (Yjs)** as the default — proven, performant, decentralized-friendly. OT considered only where CRDT overhead is unacceptable (rare).

**Capabilities:**
- Presence (cursors, selections, avatars).
- Live edits with sub-100ms perceived latency on local network, sub-300ms over WAN.
- Conflict-free merge.
- Offline edit + reconcile on reconnect.
- Comments anchored to content positions (resilient to edits).

**Infrastructure:** Yjs WebSocket provider with Redis-backed persistence; shard by document ID; periodic checkpoint to PostgreSQL/object storage.

---

### 3.23 Task & Case Management

**Purpose:** Operational unit of work — investigations, incidents, service requests, applications, claims — handled with state, ownership, SLA, and history.

**Capabilities:**
- Configurable case types per tenant (custom fields, lifecycle states, transitions).
- Assignment (manual, round-robin, skill-based, geofence-based).
- SLA tracking with breach alerts.
- Escalation policies.
- Linked artifacts (documents, map features, related cases, chat channels).
- Activity timeline with full audit.
- Reporting and analytics (case volume, MTTR, breach rate, by-team load).

**Backed by:** Workflow engine for state transitions; PostgreSQL for persistence; ClickHouse for analytics; chat module for case discussions.

---

### 3.24 Media Management

**Purpose:** Specialized handling for image, video, audio assets — beyond raw file storage.

**Capabilities:**
- Transcoding pipeline (video → multiple resolutions/codecs, image → multiple sizes/formats including WebP/AVIF).
- Thumbnail generation.
- Metadata extraction (EXIF, geolocation, duration, codec).
- Streaming delivery (HLS for video).
- DRM consideration (out of MVP scope; pluggable).
- Watermarking (visible and invisible/forensic).

**Implementation:** FFmpeg-based workers; object storage with CDN front; signed URLs for time-limited access.

---

### 3.25 Geospatial Analytics

(Covered in §4.)

**Summary:** Heatmaps, kernel density, hot-spot analysis (Getis-Ord Gi*), spatial autocorrelation (Moran's I), origin-destination matrices, isochrones, gravity models, time-space cubes — running on PostGIS for ad-hoc and ClickHouse with geohash columns for high-volume.

---

### 3.26 Operational Monitoring Center

**Purpose:** Mission-control style real-time situational awareness — multi-screen "wall view" combining maps, KPIs, alert streams, video feeds, and incident states.

**Capabilities:**
- Multi-monitor layout templates.
- Real-time map with live asset positions.
- Alert ticker with severity color-coding.
- KPI tiles with thresholds and sparklines.
- Drill-down on any element to its detail context.
- Shift handover notes.
- Time-replay (view state of system at past timestamp — relies on event log replay).

**Realtime backbone:** WebSocket subscriptions to event channels; UI optimistic rendering; reconnect-and-replay on connection drop.

---

### 3.27 Incident / Event Management

**Purpose:** Structured response to operational events — detection → triage → response → resolution → post-mortem.

**Capabilities:**
- Incident creation (manual, auto from alert, auto from rule).
- Severity classification (SEV1–SEV5).
- Roles (Incident Commander, Comms Lead, Ops Lead).
- Status page integration.
- Timeline auto-population from chat, system events, status changes.
- Post-mortem template.
- Trend analytics (incidents by category, MTTD, MTTR, recurrence).

**Integrations:** Notification module for paging; chat module for war room channel auto-creation; workflow engine for response runbooks.

---

## 4. DETAILED GIS ARCHITECTURE

### 4.1 Architectural Principles

GIS is **not a feature** — it is a **first-class architectural concern**. Every business object that has a location attribute is queryable spatially without ETL. Every map view is a composition of the same data the rest of the platform uses, not a separate copy.

### 4.2 Map Engine

**Frontend:** **MapLibre GL JS** (open-source fork of Mapbox GL pre-1.0).

- WebGL-rendered vector tiles for crisp, performant rendering at all zoom levels.
- Style spec for declarative layer styling (data-driven styling via expressions).
- Plugin ecosystem: heatmap, deck.gl integration for advanced visualization (3D extrusions, hexbins, arc layers).

**Backend tile services:**
- **Vector tile server:** `pg_tileserv` for direct PostGIS → MVT, or custom NestJS `martin`-equivalent service for tenant-aware filtering.
- **Raster tile server:** `MapServer` or `GeoServer` for legacy raster sources, fronted by tile cache.

### 4.3 Tile Rendering Architecture

```
Client (MapLibre)
  → CDN (CloudFront/Cloudflare)
    → Tile cache (Varnish or Redis-backed cache layer)
      → Tile generation service
        → PostGIS (ST_AsMVT) / Raster source
```

- **Cache strategy:** Generated tiles cached at CDN with `Cache-Control: public, max-age=86400` for static layers; private cache with short TTL for tenant-specific or time-sensitive layers.
- **Cache invalidation:** Event-driven — when underlying data changes, affected tiles (computed via geometry → tile coordinate mapping) are purged.
- **Pre-generation:** For known-popular zoom ranges, tiles pre-generated nightly via batch job.

### 4.4 Vector Tiles

- **Format:** Mapbox Vector Tile (MVT) protobuf, the de-facto standard.
- **Generation:** `ST_AsMVT(ST_AsMVTGeom(geom, ST_TileEnvelope(z, x, y)), 'layer_name', 4096, 'geom')`.
- **Layering:** Multiple feature layers per tile to minimize HTTP requests; styled independently on the client.
- **Generalization:** Server-side simplification via `ST_SimplifyPreserveTopology` based on zoom level — full detail only at zoom ≥ 14, progressive simplification at lower zooms.

### 4.5 Spatial Queries

PostGIS is the spatial query workhorse. Standard query patterns:

| Pattern | PostGIS Function |
|---|---|
| Containment | `ST_Contains`, `ST_Within` |
| Intersection | `ST_Intersects` |
| Distance / nearest neighbor | `ST_DWithin`, `<->` operator with GIST index |
| Buffer | `ST_Buffer` (geographic via `geography` type for true distance on sphere) |
| Aggregation | `ST_Union`, `ST_Collect`, `ST_ClusterWithin` |
| Routing | `pgRouting` extension (`pgr_dijkstra`, `pgr_aStar`) |

### 4.6 Spatial Indexing

- **GIST indexes** on every `geometry` and `geography` column.
- **BRIN indexes** for time-partitioned spatial data with monotonic insert pattern.
- **Generalized indexes:** for high-cardinality geofence evaluation, materialized geohash columns indexed with B-tree for fast prefix scans.
- **Custom spatial partitioning:** large tables partitioned by H3 cell or QuadKey for parallel query.

### 4.7 Geofencing

**Definition:** Polygons (or multi-polygons) that trigger events when assets enter/exit/dwell.

**Architecture:**
1. Geofence definitions stored in PostGIS.
2. Asset position updates flow through the event bus.
3. Geofence evaluation service (Stateful, in-memory R-tree mirroring PostGIS) evaluates each position against active fences.
4. Triggered events (`geofence.entered`, `geofence.exited`, `geofence.dwell_threshold_reached`) published to event bus → consumed by alerting, workflow, notification.

**Performance:** R-tree gives O(log n) per evaluation; with 100k geofences and 10k assets at 1Hz, ~10M evaluations/s achievable on a single node; sharded by tenant.

### 4.8 Layers Model

A **layer** is a logical visualization of a dataset on the map.

| Layer Type | Source | Use Case |
|---|---|---|
| **Feature layer** | PostGIS table | Editable vector data |
| **Tile layer** | Pre-rendered tiles | Reference data (basemaps, admin boundaries) |
| **Live layer** | WebSocket-fed feature collection | Realtime asset positions |
| **Heatmap layer** | Aggregated points | Density visualization |
| **Cluster layer** | Point features auto-clustered | High-cardinality point data |
| **Computed layer** | Result of spatial query | Ad-hoc analytics |
| **External WMS/WMTS** | Third-party map service | Government/agency data integration |

### 4.9 Geo Objects (Feature Model)

Every spatial feature has:
- Stable ID (UUID).
- Geometry (`geometry(GeometryZ, 4326)` — WGS84, supporting Z dimension).
- Properties (jsonb, schema-validated per layer).
- Tenant context.
- Lifecycle metadata (created/modified/deleted with actor + timestamp).
- Permission ACL (inherited from layer, overrideable per feature).

### 4.10 Map Permissions

- **Layer-level:** Roles permitted to view/edit/admin a layer.
- **Feature-level:** Per-feature ACL for high-sensitivity data.
- **Geographic-level:** Permission scoped by polygon (e.g., "Region Manager X can edit features only within their region geometry"). Implemented via ABAC policy evaluating `ST_Contains(user.region_polygon, feature.geom)`.

### 4.11 Realtime Tracking

Asset position telemetry pipeline:

```
IoT/Mobile device
  → MQTT broker (or HTTP ingestion endpoint)
    → Validation/normalization service
      → Event bus (NATS)
        → Parallel consumers:
          • PostGIS writer (current_positions table, with hypertable for history)
          • Geofence evaluator
          • WebSocket broadcaster (live layer subscribers)
          • ClickHouse projector (movement analytics)
```

- **Throughput target:** 100k positions/s sustained.
- **Live layer subscription:** Clients subscribe to a viewport bounding box → server pushes only positions within bbox.

### 4.12 Route Visualization

- Pre-computed routes stored as `LineString`.
- Live routes (in-progress) stored as growing `LineString` with periodic snapshots.
- Animated route playback via timeline scrubber on the frontend.

### 4.13 Spatial Analytics

**Ad-hoc analytical patterns:**
- **Hot-spot analysis** (Getis-Ord Gi*) — identifies statistically significant spatial clusters of high/low values.
- **Density-based clustering** (DBSCAN via PostGIS ST_ClusterDBSCAN).
- **Origin-destination matrices** — for flow visualization.
- **Isochrones** — reachability polygons computed via `pgRouting` with travel-time edges.

**Scale strategy:** PostGIS for ad-hoc; ClickHouse with H3 geohash columns for billion-row aggregations (e.g., "for every H3 cell at resolution 8, what was the average dwell time over Q3?").

### 4.14 Heatmaps

- **Client-side:** MapLibre heatmap layer for interactive zoom/pan.
- **Server-side:** Pre-aggregated grid (H3 or QuadKey cells) for very large datasets, served as vector tile of cell polygons with intensity property.

### 4.15 Clustering

- **Dynamic clustering:** `supercluster` library on the client for points up to ~1M.
- **Server-side clustering:** For >1M points, `ST_ClusterWithin` server-side with zoom-level-dependent radius.

### 4.16 Coordinate Systems

- **Storage:** WGS84 (EPSG:4326) as canonical.
- **Display:** Web Mercator (EPSG:3857) for tile rendering.
- **Local projections:** Per-region UTM zones or national grids (e.g., EPSG:32642 for Uzbekistan UTM 42N) supported via on-the-fly reprojection (`ST_Transform`).
- **Datum transformations:** PROJ.4 backed; configurable per tenant default.

### 4.17 GIS Performance Optimization

- **Geometry simplification by zoom level** (precomputed columns: `geom_z6`, `geom_z10`, `geom_z14`).
- **Materialized views** for expensive aggregations refreshed on event.
- **Read replicas** for tile generation to offload OLTP.
- **Connection pooling** via PgBouncer in transaction mode.
- **Tile compression** (gzip/brotli at the CDN).
- **Geometry caching** of expensive `ST_Buffer`/`ST_Union` results.

### 4.18 Map Caching Strategy

- **L1 (Browser):** Client-side cache via MapLibre's tile cache.
- **L2 (CDN):** Public/static layers cached at edge.
- **L3 (Tile cache layer):** Varnish or Redis-backed cache between tile server and CDN.
- **L4 (PostGIS query cache):** materialized views.

Cache invalidation: tag-based; when a feature changes, tags `(layer_id, tile_xyz)` are invalidated.

---

## 5. DATA ARCHITECTURE

### 5.1 Workload Separation

| Workload | Datastore | Justification |
|---|---|---|
| **OLTP (state of record)** | PostgreSQL 16+ with PostGIS | ACID, relational integrity, mature, spatial-native |
| **OLAP (analytics)** | ClickHouse 24+ | Columnar, vectorized execution, billion-row dashboard performance |
| **Cache, ephemeral state, queues** | Redis 7+ | Sub-ms latency, rich datatypes, Streams for queues |
| **Full-text & semantic search** | OpenSearch 2.x (or Elasticsearch 8.x) | BM25, kNN, faceting, mature operations |
| **Object storage (blobs)** | S3-compatible (MinIO on-prem, AWS S3 cloud) | Unbounded scale, durability, native lifecycle |
| **Vector embeddings** | Qdrant or Milvus | Production-grade ANN, hybrid search |
| **Audit (immutable)** | ClickHouse (append-only) + S3 archival | Cheap retention, fast ad-hoc queries |
| **Time-series telemetry** | TimescaleDB extension on PostgreSQL **or** ClickHouse | Hypertables / partitioning; choose by volume |
| **Event log (durable)** | NATS JetStream / Kafka | Replayable, partitioned, durable |

### 5.2 PostgreSQL Responsibilities

- All transactional state of record.
- Spatial data (PostGIS).
- Outbox table for event publishing.
- User-defined entities (custom case types, custom fields).
- Transactional graph data (lightweight; for heavy graph workloads, Neo4j optional).
- Configuration, settings, feature flags.

**Sizing & scaling:**
- Vertical first (up to ~64 vCPU, 512GB RAM single instance).
- Read replicas (streaming replication) for analytics offload, tile generation.
- Logical replication for selective replication (e.g., to a sandbox).
- Sharding via Citus when single-node ceiling reached (not Day-1).

**HA:** Patroni-managed cluster (3 nodes: leader + 2 replicas) with automated failover; PgBouncer for connection pooling.

### 5.3 ClickHouse Responsibilities

- Event log materialization (every domain event → ClickHouse table).
- Pre-aggregated analytical views (materialized views, projections, AggregatingMergeTree).
- High-volume telemetry (positions, sensor data, audit events).
- Cross-domain analytical joins.

**Schema patterns:**
- Wide event tables with all relevant attributes denormalized.
- Materialized views from raw event tables to aggregated views.
- Projections for alternative sort orders.
- TTL policies for tiered storage (hot SSD → warm HDD → S3 cold).

**Cluster topology:**
- Sharded + replicated cluster (e.g., 3 shards × 2 replicas).
- ZooKeeper / ClickHouse Keeper for coordination.
- Distributed tables for query fan-out.

### 5.4 Event Sourcing Considerations

Full event sourcing is **not** the default. The default is **CQRS-lite with event publishing**:
- State of record in PostgreSQL (mutable, current state).
- Event stream (NATS/Kafka + ClickHouse archive) is the **history of changes**, not the source of truth.

Modules where full event sourcing **is** justified (and applied selectively):
- **Audit module** — events are the truth.
- **Workflow engine** — workflow history reconstructable from events.
- **Asset tracking** — historical positions are events.

**Why not everywhere:** Event sourcing imposes high cognitive cost on developers, complex projection management, and snapshot strategies. Reserve for domains where temporal reconstruction is a requirement.

### 5.5 Data Lake Considerations

For long-term analytical storage and "cold" compliance archives:
- **Object storage in Parquet format** (S3-compatible).
- **Catalog:** AWS Glue, or Apache Iceberg for ACID over object storage (preferred for lakehouse pattern).
- **Query engine:** Trino / Presto for ad-hoc; ClickHouse with S3 table function for occasional access.

Activated in **Horizon 2+** when storage volumes and analytical breadth justify it.

### 5.6 Indexing Strategies

| Datastore | Strategy |
|---|---|
| PostgreSQL B-tree | All foreign keys, frequently filtered columns |
| PostgreSQL GIST | All geometry columns |
| PostgreSQL GIN | jsonb columns with frequent containment queries; full-text columns for in-DB search |
| PostgreSQL BRIN | Time-series append-only tables (`created_at`) |
| PostgreSQL partial | Sparse high-selectivity predicates (e.g., `WHERE status = 'active'`) |
| ClickHouse primary key | Defines sort order; chosen for query patterns, not uniqueness |
| ClickHouse skip indexes | minmax/set/bloom for non-prefix filters |
| ClickHouse projections | Alternative sort orders without duplication overhead |
| OpenSearch | Mapping-driven; keyword vs text vs date carefully chosen |

### 5.7 Partitioning

- **PostgreSQL declarative partitioning** for large tables — by tenant_id (hash) or by time (range).
- **ClickHouse partitioning** — typically by month (`PARTITION BY toYYYYMM(ts)`) for TTL and DROP PARTITION operations.
- **Object storage prefix partitioning** — `s3://bucket/tenant_id=xxx/year=2026/month=05/...` for partition pruning by query engines.

### 5.8 Archival & Retention

- Per-tenant, per-data-class retention policies declared in metadata.
- Automated archival to cold storage (S3 Glacier / Azure Archive).
- Deletion job runs nightly; respects legal holds.
- Cryptographic erasure for "right to be forgotten" — destroying tenant DEK renders ciphertext unrecoverable without full row deletion.

### 5.9 ETL/ELT Pipelines

- **CDC from external systems:** Debezium → Kafka → NestJS consumer → normalization → platform store.
- **Batch ELT:** Airflow or Dagster orchestrating SQL transformations within ClickHouse (preferring ELT over ETL).
- **Realtime ETL:** Kafka Streams or NestJS workers for low-latency transformations.

### 5.10 Realtime Streams

- **Ingestion:** HTTP, MQTT, Kafka producer API, or NATS publish.
- **Processing:** Stateful consumers in NestJS with idempotency keys; for complex stream processing (windowed aggregations, joins), consider Apache Flink or ksqlDB at Horizon 2+.
- **Sink:** Multiple — PostgreSQL (current state), ClickHouse (history), WebSocket (live UI).

### 5.11 Synchronization Strategies

- **Outbox pattern** for atomic write + event publish.
- **Saga pattern** for cross-module transactions (compensation-based).
- **Eventual consistency** is the default; UI shows optimistic state with reconciliation on event arrival.
- **Strong consistency** within a single aggregate; cross-aggregate consistency is eventual.

---

## 6. SECURITY ARCHITECTURE

### 6.1 RBAC

Standard role-permission model:
- **Roles** are tenant-scoped collections of permissions.
- **Permissions** are tuples of `(resource_type, action)` — e.g., `dashboard:read`, `workflow:approve`.
- **Users** receive roles directly or via group membership.
- **System roles** (e.g., `platform_admin`, `tenant_admin`, `auditor`) are immutable and reserved.

### 6.2 ABAC

For decisions where role membership is insufficient. Policies evaluated by OPA at request time, with attributes from:
- **Subject:** user attributes (department, clearance level, training certifications).
- **Resource:** classification, owner, tags, location, age.
- **Environment:** time, request IP geolocation, device posture, MFA recency.
- **Action:** the operation requested.

**Example policy (Rego):**
```rego
allow {
  input.action == "document:read"
  input.resource.classification == "confidential"
  input.subject.clearance_level >= 3
  input.environment.mfa_age_seconds < 3600
}
```

### 6.3 Tenant Isolation

- **Logical:** RLS policies on every table; tenant ID injected into session.
- **Cryptographic:** Per-tenant DEK (Data Encryption Key) wrapped by KEK (Key Encryption Key) in KMS/Vault. Application encrypts sensitive fields at write.
- **Network:** Per-tenant network policies in Kubernetes (NetworkPolicy) for high-isolation tenants.
- **Audit:** Per-tenant audit indices in OpenSearch.

### 6.4 Row-Level Security

PostgreSQL RLS policies on every tenant-scoped table:
```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Application sets `app.tenant_id` from validated JWT at start of every transaction. Bypass requires explicit superuser role used only by migrations.

### 6.5 Audit Trails

(Detailed in §3.15.) Every action logged immutably; tamper-evident chain; SIEM-exportable.

### 6.6 Immutable Logging

- WORM property enforced by storage configuration (S3 Object Lock in compliance mode for archived audit; ClickHouse append-only enforced by absent UPDATE/DELETE permissions in service role).
- Hash chain: `this_hash = SHA256(this_record || prev_hash)`.
- Daily Merkle root computed and notarized externally.

### 6.7 Encryption at Rest

- **Datastore-level:** PostgreSQL TDE (Transparent Data Encryption) via filesystem encryption (LUKS) or PostgreSQL TDE extension.
- **Application-level:** Field-level encryption for sensitive PII (SSN, financial accounts) using per-tenant DEK.
- **Object storage:** SSE-KMS with customer-managed keys.
- **Backups:** Encrypted before leaving the database server.

### 6.8 Encryption in Transit

- **TLS 1.3** for all external traffic.
- **mTLS** for service-to-service traffic within the cluster (Istio/Linkerd service mesh).
- **Certificate rotation:** Automated via cert-manager + internal CA; certificate lifetime < 90 days.

### 6.9 Secrets Management

- **HashiCorp Vault** (or cloud-equivalent — AWS Secrets Manager, Azure Key Vault) as the canonical secret store.
- **No secrets in environment variables in production** — services authenticate to Vault via short-lived tokens (Kubernetes service account → Vault auth).
- **Dynamic secrets** for database credentials (rotated per pod start).
- **Secret zero problem** addressed via Kubernetes service account JWTs.

### 6.10 Session Management

- Access tokens: short-lived (15 min), JWT, signed RS256.
- Refresh tokens: longer-lived (30 days, configurable), rotating, replay-detectable (one-time use).
- Sessions tracked in Redis with device, IP, user agent, last activity.
- Concurrent session limits configurable per role.
- Forced logout propagated via NATS to all WebSocket gateways.

### 6.11 MFA

- **TOTP** (RFC 6238) — default; works with any open authenticator app (Google Authenticator, Authy, Aegis, FreeOTP).
- **WebAuthn/FIDO2** — preferred for high-trust users (passkeys, hardware tokens such as YubiKey/SoloKey).
- **Backup codes** (one-time use, hashed) — for recovery when primary factor is lost.
- **No SMS-based MFA** — SMS is excluded by policy: it is per-message billed, vulnerable to SIM-swap and SS7 attacks, and unavailable in airgapped or sovereign deployments.
- MFA enforcement policies per role and per action sensitivity.

### 6.12 SSO

- **OIDC** (preferred): integrate as RP with corporate IdP (Keycloak, Okta, Azure AD, Google Workspace).
- **SAML 2.0**: for legacy IdPs.
- **JIT provisioning**: on first SSO login, user provisioned; group mapping from SAML attributes / OIDC claims.
- **SCIM** (System for Cross-domain Identity Management): for automated provisioning/deprovisioning.

### 6.13 Device & Session Monitoring

- Device fingerprinting (browser fingerprint + IP + MFA state).
- Anomaly detection: impossible travel, new device, unusual hours.
- Risk-based step-up authentication.
- Admin visibility into all active sessions per user; remote logout capability.

### 6.14 DLP (Data Loss Prevention)

- Outbound API gateway inspects responses for sensitive patterns (regex + dictionary + classifier-based).
- File downloads logged with full audit including file hash.
- Watermarking on document export (visible + invisible/forensic).
- Egress controls — outbound webhook destinations whitelisted per tenant.

### 6.15 Compliance Readiness

- **SOC 2 Type II** — control mapping documented per platform area.
- **ISO 27001** — ISMS documentation maintained; controls auditable.
- **GDPR** — data subject access, portability, erasure (cryptographic + logical) supported.
- **HIPAA** (US healthcare) — BAA-ready architecture; PHI segregation patterns documented.
- **National data residency** — deployable per-region with no cross-region data flow option.

### 6.16 Zero Trust

- **Never trust, always verify** at every layer.
- **No implicit network trust** — even intra-cluster traffic requires authentication.
- **Least privilege** — service accounts have minimum required permissions; ephemeral elevation for break-glass.
- **Continuous verification** — token freshness, MFA recency, device posture re-evaluated continuously.
- **Microsegmentation** — network policies isolate services; no flat networks.

---

## 7. REALTIME ARCHITECTURE

### 7.1 WebSocket Infrastructure

**Gateway:** Dedicated NestJS WebSocket gateway service (separate process from REST API for independent scaling).

**Protocol:** WebSocket with custom JSON protocol layered on top:
```json
{
  "type": "subscribe" | "unsubscribe" | "publish" | "ack" | "presence",
  "channel": "...",
  "payload": {...},
  "msgId": "uuid",
  "ts": 1714944000000
}
```

**Authentication:** JWT presented in the WebSocket upgrade request (Authorization header or first message); validated by gateway; renewed via refresh token before expiry without disconnecting.

**Connection lifecycle:**
1. Client connects → JWT validated → tenant + user attached to connection.
2. Client subscribes to channels (e.g., `tenant:X:dashboard:Y`, `case:Z`, `presence:wiki-page-W`).
3. Server pushes events on subscribed channels.
4. Heartbeat every 30s; missed heartbeat → disconnect → client reconnects with last-seen offset for replay.

### 7.2 Realtime Synchronization

**Pattern:** Event-driven UI updates with optimistic local state.

1. User performs action → frontend optimistically updates local state.
2. Action sent to backend → backend processes → emits event.
3. Event arrives via WebSocket → frontend reconciles with server state (typically a no-op since optimistic was correct; on conflict, server state wins, UI gracefully corrects).

**Library:** Frontend uses a state management approach (Zustand or Redux Toolkit Query) with WebSocket subscription middleware that auto-merges incoming events.

### 7.3 Presence System

**Capabilities:**
- Who is currently viewing a resource (page, dashboard, document, case).
- Who is currently online globally.
- Typing indicators (in chat, in document comments).
- Cursor positions (in collaborative editing).

**Implementation:**
- Redis sorted sets keyed by `presence:{resource_id}` with member = `user_id`, score = expiration timestamp.
- Heartbeat every 15s extends membership.
- Expired members evicted lazily and on read.
- WebSocket gateway publishes presence change events (`presence.user_joined`, `presence.user_left`).

**Scale:** Up to 10⁵ concurrent presences per resource via Redis cluster sharding.

### 7.4 Event Streams

Internal eventing flows through NATS/Kafka. Frontend-relevant events flow from event bus → WebSocket gateway → subscribed clients. The gateway is a fan-out service: it subscribes to relevant subject patterns and re-publishes to authorized client subscriptions.

**Authorization at fan-out:** Every outbound message is checked against the recipient's permissions. For high-cardinality permission sets, a "subscription filter" computed at subscribe-time and cached per connection.

### 7.5 Optimistic Updates

Pattern enforced via:
- **Idempotency keys** on commands so retries are safe.
- **Server-issued IDs** — for new entities, frontend generates a temporary client-side ID; server returns the canonical ID; frontend swaps.
- **Conflict resolution** — server is authoritative; on conflict, server state replaces local state with smooth UI transition.

### 7.6 Distributed Events

(Cross-region, cross-cluster.)

- **Single region (Day 1):** Single NATS cluster.
- **Multi-region (Horizon 2):** NATS Leafnodes or Kafka MirrorMaker 2.0 for selective cross-region replication.
- **Selective replication:** Not all events cross regions; a topic policy defines crossings.

### 7.7 Notification Architecture

(See §3.13.)

Reliability:
- Exactly-once delivery per channel via consumer offset + idempotency key.
- Retry with exponential backoff (base 2s, max 10 min, 5 attempts).
- Dead-letter queue with manual replay.

### 7.8 Scaling WebSocket Infrastructure

**Horizontal scaling:**
- Sticky sessions at L4 load balancer (ALB/NLB) keyed by session cookie or token hash.
- Cross-instance fan-out via Redis Pub/Sub or NATS internal subjects (events targeted at user X delivered regardless of which gateway instance holds the connection).

**Capacity per instance:**
- ~50k concurrent connections per node (limited by ulimit, kernel settings, memory).
- Backpressure: per-connection send buffer; slow consumers disconnected.

**Connection budget:**
- 100 nodes × 50k = 5M concurrent — far beyond planning horizons.

### 7.9 Realtime Collaboration Architecture

(See §3.22.)

CRDT (Yjs) over WebSocket; per-document Yjs `Doc` with awareness protocol for presence; persistence via periodic snapshot to PostgreSQL/object storage; reconnect replays missed updates.

---

## 8. VIDEO/AUDIO COMMUNICATION ARCHITECTURE

### 8.1 WebRTC Foundation

WebRTC is the canonical browser-native protocol for low-latency media. Native mobile clients use WebRTC libraries (libwebrtc) for parity.

### 8.2 SFU Topology

**Selective Forwarding Unit (SFU)** chosen over MCU (mixing) and Mesh (P2P):
- **Mesh** doesn't scale beyond ~5 participants (n² connections).
- **MCU** centralizes mixing — high server cost, single decode-encode bottleneck.
- **SFU** forwards encoded streams selectively — scales to 50+ participants per room with reasonable cost.

**SFU choice:**
- **LiveKit** (preferred) — open source, Kubernetes-native, robust SDKs (web, iOS, Android, React Native), built-in egress (recording, RTMP), clean operational story.
- **Mediasoup** — lower-level, more control, but more engineering investment.
- **Jitsi Videobridge** — solid alternative when full-stack Jitsi (Jicofo, prosody) is acceptable.

### 8.3 TURN/STUN

- **STUN** (Session Traversal Utilities for NAT): public reflection server for clients to discover their public IP.
- **TURN** (Traversal Using Relays around NAT): media relay when direct P2P/STUN fails (~10–20% of connections).
- **Implementation:** **coturn** server cluster, TLS-fronted (turns:// for symmetric NAT and corporate firewalls that block UDP).

**Sizing:** Each TURN server handles ~500–1000 simultaneous relayed flows depending on bitrate; cluster sized for peak concurrent meetings.

### 8.4 Screen Sharing

- WebRTC's `getDisplayMedia()` API.
- Higher resolution / lower framerate than video (typically 1920×1080 @ 5–15 fps).
- Bandwidth-aware encoding (VP9/AV1 for efficiency where supported).
- SFU treats screen share as an additional video track on the publisher.

### 8.5 Adaptive Bitrate

- **Simulcast**: publisher sends multiple resolutions (e.g., 180p, 360p, 720p) of the same stream; SFU forwards the appropriate layer per subscriber based on their bandwidth/UI size.
- **SVC (Scalable Video Coding)** with VP9/AV1 — finer-grained adaptivity; LiveKit supports SVC natively.
- **Server-side bandwidth estimation** for each subscriber; dynamic stream layer switching.

### 8.6 Recording

- **Egress service** (LiveKit Egress) joins rooms as a passive participant, mixes, encodes to MP4/HLS, uploads to object storage.
- **Composite recording** (single mixed file) and **track recording** (separate file per participant) options.
- **Storage:** Object storage with lifecycle to cold tier; access via signed URLs.
- **Compliance:** Recording consent enforced; participants notified; recording metadata in audit log.

### 8.7 Moderation

- Host controls: mute/unmute participant, remove participant, lock room, end for all.
- Waiting room / lobby.
- Background blur / virtual backgrounds (client-side).
- Profanity / inappropriate content detection (out of MVP; pluggable).

### 8.8 Enterprise Conferencing

- Integration with self-hosted calendar (CalDAV / Nextcloud / SOGo) for meeting scheduling; CalDAV interoperates with most clients.
- E2EE (end-to-end encryption) optional via DTLS-SRTP keys exchanged via secure side channel; default is hop-by-hop encryption (DTLS-SRTP from client to SFU).
- Live captions / transcription via self-hosted AI services (see §16) — no dependency on external paid transcription APIs.
- Polls, hand-raise, in-meeting chat.

**Excluded from scope:** PSTN dial-in, SIP trunk integration, telephony bridges. These rely on per-minute billed external carriers and are explicitly out of scope to keep the platform free of usage-based external dependencies.

### 8.9 Scaling Media Infrastructure

**Per-region SFU clusters:**
- Multiple SFU nodes per region.
- Coordinator service (LiveKit Server) for room placement and signaling.
- Geographic placement of users to nearest SFU.
- Cross-region cascading for global meetings: SFUs connected as a mesh; participants connect to local SFU; SFUs forward streams between each other.

**Capacity:**
- Single SFU node: ~500–1000 publishers, ~5000–10000 subscribers (depending on bitrate).
- Cluster: linear scaling.
- Cost driver: bandwidth — typical bidirectional video meeting at 720p ~1.5 Mbps per participant.

---

## 9. ENTERPRISE FILE MANAGEMENT SYSTEM

### 9.1 Folder Model

- Hierarchical (tree); each folder has parent, children, owner, ACL, metadata.
- Path materialized as `ltree` in PostgreSQL for efficient subtree queries.
- Move/rename operations transactional; subtree path updates via single SQL update on `ltree`.

### 9.2 Permissions Inheritance

- ACL declared at folder; children inherit unless overridden.
- Override types: **add** permissions, **revoke** permissions, **break inheritance entirely**.
- Effective permission computation: walk up the tree, merge ACLs by type.
- Cached per (user, folder) tuple; invalidated on ACL change anywhere on the path.

### 9.3 File Versioning

- Every save creates a new version; previous versions immutable.
- Version metadata: version number, author, timestamp, comment, checksum.
- Storage strategy: copy-on-write at object storage layer; deduplicated by content hash to avoid storage explosion.
- Version diff: textual diff for text formats; metadata-only for binary.
- Restore: pin a previous version as "current"; original "current" becomes a previous version.

### 9.4 Metadata

- **System metadata:** size, MIME type, content hash, checksum, encryption status, owner, timestamps.
- **User metadata:** tags, custom fields per file type.
- **Extracted metadata:** EXIF (images), document metadata (Word/PDF), code-language detection (source files).
- **AI-derived metadata** (Horizon 2+): auto-classification, entity extraction, summary embedding.

### 9.5 Previews

- **Preview pipeline:** on upload, file enters preview generation queue.
- **Image:** thumbnail (multiple sizes), web-optimized variants (WebP).
- **Document:** PDF rendering via LibreOffice headless or Pandoc; first-page thumbnail; full-document inline preview (PDF served via PDF.js).
- **Video:** keyframe thumbnail; HLS rendition for streaming.
- **Audio:** waveform image; web-playable rendition.
- **Code:** syntax-highlighted HTML (via Shiki/Prism on the server).

**Implementation:** Workers per file type; horizontally scaled; bounded memory (kill switch on OOM).

### 9.6 Sharing

- **Internal sharing:** by user, group, or role within the tenant.
- **External sharing:** public link (expiration, password optional, view-only or download).
- **Federated sharing** (cross-tenant, Horizon 2+): requires accepted federation between tenants.

### 9.7 Temporary Links

- Pre-signed object storage URL with TTL.
- Short URL via internal redirector with revocable backing token.
- Access logged in audit.
- Watermarking applied if file marked as confidential.

### 9.8 Encrypted Storage

- All files encrypted at rest (SSE-KMS or application-level for high-sensitivity).
- Per-tenant DEK; KEK in HSM-backed KMS.
- Re-encryption on key rotation handled by background job.
- Cryptographic erasure: delete the DEK to render all tenant files unrecoverable.

### 9.9 Object Storage Integration

- **Backend:** MinIO (on-prem) or S3 (cloud). Both speak the S3 API.
- **Multipart upload** for large files (>100MB).
- **Resumable upload protocol:** **tus.io** — interrupt-tolerant, browser-friendly.
- **Direct upload from browser:** pre-signed PUT URL; backend never proxies bytes for large files.
- **Direct download:** pre-signed GET URL; CDN caching for public.

### 9.10 Retention Policies

- Per-folder or per-file-class retention rules (e.g., "contracts retained 7 years from execution; deleted thereafter unless on legal hold").
- Background job evaluates retention nightly.
- Legal hold suspends deletion; lifted only by authorized officer with audit trail.

### 9.11 Search Indexing

- **On upload:** content extracted (Apache Tika or per-format extractors) and indexed in OpenSearch.
- **Reindexing:** triggered on metadata change or content update.
- **Multi-language:** language detection → per-language analyzer.
- **OCR for images and scanned PDFs** (Horizon 2 with AI module): Tesseract or cloud OCR; text added to search index.
- **Permission-aware:** index includes permission metadata; search query filters at retrieval.

---

## 10. WORKFLOW / BPM ARCHITECTURE

### 10.1 Workflow Engine Choice

| Engine | Pros | Cons | Verdict |
|---|---|---|---|
| **Temporal (open-source self-hosted)** | Code-first, durable execution, excellent SDKs, active development; fully free under MIT license when self-hosted | Steeper learning curve; not BPMN | **Default choice** |
| **Camunda 7 Community Edition** | Visual BPMN, open-source Apache 2.0, mature | Less active than Camunda 8; classic JVM stack | Alternative when BPMN visual modeling is required |
| **n8n (Sustainable Use License, self-hosted)** | Low-code, accessible to power users; free for internal business use when self-hosted | Not enterprise-scale workflow durability | **Operator/end-user automation** layer alongside core engine |

**Recommended:** **Temporal (self-hosted) as the durable workflow engine for system-critical processes**, with **n8n (self-hosted) as a no-code automation surface** for end-users who build their own automations. **All workflow infrastructure is self-hosted** — no managed-service subscriptions, no per-execution billing.

**Excluded:** Camunda 8 / Zeebe (cloud-licensed), Temporal Cloud (subscription), and any other workflow runtimes that require recurring vendor payments.

### 10.2 Approvals

- Approval task = workflow activity that waits for a signal.
- Multi-stage approvals: parallel ("any one approver"), serial ("each in order"), N-of-M ("3 of 5 must approve").
- Delegation: an approver can delegate to a delegate (with audit).
- Reassignment by admin (with audit).

### 10.3 Automations

- Triggers: event (any platform event), schedule (cron), manual.
- Actions: any platform API or external webhook.
- Defined as workflow code (Temporal) or visual builder (n8n).
- Sandboxed execution; resource limits.

### 10.4 Orchestration

- Long-running workflows (days, months, years) are first-class.
- Workflow state persisted in Temporal's event history; replayable.
- Versioning: workflow code changes don't break in-flight workflows (Temporal's `getVersion`).

### 10.5 State Machines

- Domain state machines (e.g., document lifecycle, case lifecycle) modeled as **finite state machines** with declarative transitions.
- Transitions include guards (preconditions), effects (side-effect actions), and event emissions.
- Engine: lightweight FSM library (XState semantics) integrated with workflow engine for long-running aspects.

### 10.6 Event-Driven Workflows

- Workflows subscribe to platform events.
- Example: "When case enters status 'critical', notify on-call + create war room channel + start MTTR timer."

### 10.7 SLA Tracking

- Each workflow step has optional SLA (deadline duration or absolute).
- Background "deadline tracker" emits `sla.warning` (75% elapsed) and `sla.breached` events.
- Breach triggers escalation policy.

### 10.8 Escalation

- Configurable escalation chains (level 1 → 2 → 3 with delays).
- Each level has notification recipients and optional auto-actions.
- Escalation audit-logged; manual override available.

### 10.9 Visual Workflow Builder

- React Flow (or similar) node-graph editor.
- Library of node types: trigger, condition, action, approval, parallel branch, delay, loop.
- Generated workflow definition (JSON) compiled to Temporal workflow at deploy time, or interpreted at runtime by a workflow runtime service.
- Validation before publish; dry-run mode.

---

## 11. API ARCHITECTURE

### 11.1 REST

- **Style:** RESTful with pragmatic deviations (e.g., `POST /resource/action` for non-CRUD operations).
- **Versioning:** URL versioning (`/v1/...`, `/v2/...`); minimum 12-month sunset for deprecated versions.
- **Format:** JSON; `application/json` default; `application/problem+json` for errors (RFC 7807).
- **Pagination:** cursor-based for unbounded lists; page-based for bounded.
- **Filtering:** structured query parameters; deep filtering via `POST /search` for complex predicates.
- **Idempotency:** `Idempotency-Key` header on all mutating endpoints; cached response for replay window.
- **OpenAPI:** every endpoint defined in OpenAPI 3.1; generated automatically from NestJS decorators.

### 11.2 GraphQL

GraphQL is **selectively** offered, not platform-wide:
- **For frontend BFF:** GraphQL is a strong fit for composing data from multiple services with minimal over-fetch.
- **For external API:** REST preferred for simplicity, caching, and tooling familiarity; GraphQL available on request.
- **Implementation:** Apollo Server or NestJS code-first GraphQL; persisted queries to mitigate cost and security risks.

### 11.3 WebSocket APIs

- For realtime subscriptions; never for request/response (which is REST/GraphQL territory).
- Subjects/channels structured as `tenant:X:domain:Y:resource:Z`.
- Versioned via subject prefix.

### 11.4 Internal APIs

- Service-to-service via REST or gRPC.
- gRPC preferred for high-RPC services (analytics, search) — schema-strict, performant.
- mTLS authenticated; service identity via SPIFFE/SPIRE.

### 11.5 External APIs

- Same OpenAPI contract as internal but exposed through gateway with rate limiting, WAF, and quota.
- Per-client API keys + OAuth2 client credentials.
- Webhooks for outbound events (signed payloads, retry, dead-letter).

### 11.6 API Versioning

- **URL versioning** (`/v1/`, `/v2/`).
- **Deprecation headers** (`Sunset: <date>`, `Deprecation: true`).
- **Compatibility tests** in CI: every version's contract tests must pass against current implementation.
- **Maximum N-2 versions** supported.

### 11.7 API Gateway

(Detailed in §3.17.)

### 11.8 Rate Limiting

- **Per-client:** token bucket, configurable burst and sustained rate.
- **Per-endpoint:** stricter for expensive endpoints (search, analytics).
- **Per-tenant:** quota at the tenant level prevents single tenant from exhausting capacity.
- **Implementation:** Redis-backed sliding window or token bucket in API gateway.

### 11.9 API Security

- **Input validation:** all input validated against OpenAPI schema; rejected with 400 if invalid.
- **Output sanitization:** PII filtering for low-privilege contexts.
- **CORS:** strict whitelist; no wildcard origins.
- **CSRF:** double-submit cookie or SameSite=Strict for cookie-auth; bearer tokens for API don't need CSRF protection.
- **Injection prevention:** parameterized queries enforced by ORM/query builder; SQL injection structurally impossible.

### 11.10 SDK Strategy

- **Official SDKs:** TypeScript/JavaScript (browser + Node.js), Python (analyst tooling).
- **Generated from OpenAPI:** ensures contract sync; reduces maintenance.
- **Hand-written wrapper layer:** for ergonomic APIs (auth helpers, retry, pagination iteration).

---

## 12. FRONTEND ARCHITECTURE

### 12.1 Enterprise UI Architecture

- **Next.js 14+ App Router** as the foundation.
- **React Server Components** for data-heavy, low-interactivity views (dashboards lists, document lists, settings).
- **Client Components** for interactive surfaces (map, dashboard widgets, chat, editor).
- **Streaming SSR** for fast first paint.
- **Code-splitting** at route and component boundaries.

### 12.2 Design System

- **Component library:** **shadcn/ui** as the base — copied into the codebase, customizable, no lock-in.
- **Tailwind CSS** for styling, with semantic design tokens (`--color-primary`, `--space-md`).
- **Storybook** for component documentation and visual regression.
- **Figma → token export** pipeline: design tokens defined in Figma, exported via Style Dictionary, applied as CSS variables.
- **Themes:** light, dark, high-contrast (accessibility); per-tenant white-label theming via CSS variable override.

### 12.3 State Management

- **Server state:** **TanStack Query** (React Query) — caching, background refresh, optimistic updates, mutation queue.
- **Client state:** **Zustand** for cross-component client state; React Context for cross-cutting concerns (theme, auth, tenant).
- **Form state:** React Hook Form + Zod schema validation.
- **URL state:** First-class — filters, search, sort persisted in URL for shareability.

**Anti-pattern avoided:** Redux for everything. Use server-state libraries for server-derived state and minimal Zustand for client-only UI state.

### 12.4 Modular Frontend

- **Module boundaries** mirror backend modules: `app/(dashboard)/`, `app/(map)/`, `app/(documents)/`, `app/(workflows)/`, `app/(chat)/`.
- **Shared:** `lib/`, `components/ui/`, `hooks/`.
- **Per-module:** components, hooks, server actions, page routes.
- **Lazy-loaded:** heavy modules (map, video) loaded on demand.

### 12.5 Workspace UI

The **enterprise workspace** is the primary UI shell:
- **Sidebar navigation:** module switcher, collapsible.
- **Main canvas:** routed view.
- **Top bar:** breadcrumbs, search, notifications, user menu.
- **Right panel (optional):** context panel — details of selected item, chat, comments.
- **Bottom dock (optional):** mini-player (video/audio call), tasks tray.

### 12.6 Command Palette

- **`Cmd/Ctrl + K`** opens command palette.
- Fuzzy search over: navigation, actions, recent items, documents, contacts.
- Backed by federated search API (§3.14).
- Plugin architecture: each module registers commands.

### 12.7 Docking Panels

- For power users: rearrangeable panels (à la VS Code).
- Persisted layout per user.
- Splits, tabs, floating windows.

### 12.8 Data Grids

- **TanStack Table v8** (MIT-licensed) with virtualization via `@tanstack/react-virtual`; **AG Grid Community Edition** (MIT) as alternative for richer built-in features.
- Server-side pagination, sorting, filtering for large datasets.
- Column reorder, resize, pin, hide; persisted per user.
- Cell renderers for rich data types (geometry preview, link, chip, image).
- Excel-like editing, copy/paste, multi-cell select.

**Excluded:** Commercial enterprise editions of grid libraries (AG Grid Enterprise, Handsontable Pro, etc.) that require per-developer or per-deployment licensing.

### 12.9 Enterprise UX Principles

- **Density-aware:** comfortable, compact, very compact modes.
- **Keyboard-first:** every action has a shortcut; tab order intentional.
- **Consistency:** identical patterns across modules (e.g., all "create" flows have identical shape).
- **Discoverability:** progressive disclosure; tooltips, in-context help.
- **Confirmations for destructive actions:** typed confirmation for irreversible ops.
- **Undo where possible:** soft delete + restore.
- **Performance perception:** skeletons, optimistic updates, instant feedback.

### 12.10 Accessibility

- **WCAG 2.1 AA** baseline; AAA on critical flows.
- **Screen reader support:** semantic HTML, ARIA where needed, focus management.
- **Keyboard navigation:** every action.
- **Color contrast:** ≥4.5:1 for text, ≥3:1 for UI components.
- **Reduced motion** preference respected.
- **i18n-ready:** every string externalized; right-to-left layout support.

### 12.11 Responsive Strategy

- **Desktop-first** (the enterprise workspace assumes ≥1280px primarily) but **adaptive** to laptop and tablet.
- **Mobile companion app** (separate codebase, React Native) for mobile-critical workflows (field operations, approvals, alerts).
- **Mobile web** supported but not the primary surface.

### 12.12 Offline-First Possibilities

- **Service Worker** for asset caching and offline shell.
- **IndexedDB** for offline data (last viewed dashboards, drafts).
- **Conflict-free reconciliation** via CRDTs for offline edits.
- **Selective:** not all modules support offline; field-operation modules prioritized.

### 12.13 Performance Budgets

- **Largest Contentful Paint:** < 2.5s on 3G.
- **Time to Interactive:** < 5s.
- **JS bundle initial:** < 250 KB gzipped per route.
- **Lighthouse score:** ≥ 90 across categories.

---

## 13. DEVOPS & INFRASTRUCTURE

### 13.1 Docker

- Every service has a `Dockerfile`.
- Multi-stage builds: build stage + runtime stage; runtime image uses `distroless` or `alpine` base.
- Non-root user.
- No secrets baked in.
- Image scanning (Trivy) in CI.
- SBOM (Software Bill of Materials) generated per image.

### 13.2 Kubernetes

- **Production runtime:** Kubernetes (managed: EKS/GKE/AKS; on-prem: Rancher RKE2 or vanilla kubeadm).
- **Workload patterns:** Deployments for stateless, StatefulSets for stateful (DB, NATS), DaemonSets for node-level agents.
- **Resource requests/limits** mandatory on every pod.
- **Pod Disruption Budgets** for HA.
- **Network policies** for microsegmentation.
- **Service mesh:** Istio or Linkerd for mTLS, observability, traffic management.
- **Ingress:** NGINX Ingress or Istio Gateway behind cloud LB / on-prem MetalLB.

### 13.3 CI/CD

- **CI:** GitHub Actions / GitLab CI / Jenkins — choice driven by procurement.
- **Pipeline stages:**
  1. Lint, type check.
  2. Unit tests.
  3. Integration tests (with ephemeral PostgreSQL/Redis via Testcontainers).
  4. Container build + scan.
  5. SBOM + vulnerability gating.
  6. Deploy to dev → staging → prod via Argo CD (GitOps).
- **CD:** Argo CD reconciling against declarative manifests in a Git repo.
- **Promotion:** PR-based; staging → prod requires manual approval.
- **Canary/Blue-Green:** Argo Rollouts; metrics-based promotion.

### 13.4 Environments

- **dev:** ephemeral per-PR environments (preview deployments).
- **staging:** integration environment, production-like, sanitized data.
- **prod:** real workload, real data, locked down.
- **dr:** standby for disaster recovery.

### 13.5 Infrastructure as Code

- **Terraform** for cloud resources (managed K8s, RDS, S3, etc.).
- **Helm charts** for Kubernetes app deployment.
- **Ansible** for on-prem node configuration (rare; prefer K8s where possible).
- **All IaC in Git;** all changes via PR with peer review.

### 13.6 Backups

- **PostgreSQL:** continuous WAL archiving (pgBackRest or wal-g) + nightly full + hourly differential.
- **ClickHouse:** scheduled backups via `BACKUP TABLE` to S3.
- **Object storage:** versioning enabled; cross-region replication for critical buckets.
- **Configuration:** Git is the source of truth.
- **Backup testing:** monthly restore drill; quarterly full DR test.

### 13.7 Disaster Recovery

- **Tier 1 (auth, audit, critical operational):** RPO 5 min, RTO 30 min — active-passive replication.
- **Tier 2 (everything else):** RPO 1 hour, RTO 4 hours — periodic backup restore.
- **DR runbook:** documented, version-controlled, regularly executed.
- **Multi-region active-active:** Horizon 3 evolution.

### 13.8 Autoscaling

- **HPA (Horizontal Pod Autoscaler):** CPU + custom metrics (queue depth, request latency).
- **VPA (Vertical Pod Autoscaler):** for stateful workloads with stable load profiles.
- **Cluster autoscaler:** for node-level scaling.
- **KEDA:** for event-driven autoscaling (e.g., scale workers based on queue depth).

### 13.9 Observability

(See §14.)

### 13.10 Logging

- **Structured JSON** logs from every service.
- **Aggregation:** Loki (Grafana Labs) or Elasticsearch.
- **Retention:** 30 days hot, 1 year archived (S3).
- **PII filtering:** logger middleware redacts known PII fields.
- **Trace correlation:** every log line has `trace_id`.

### 13.11 Tracing

- **OpenTelemetry SDK** in every service.
- **Backend:** Tempo (Grafana) or Jaeger.
- **Sampling:** head-based (10% baseline) + tail-based (always-sample errors and slow requests).
- **Cross-service propagation:** W3C Trace Context.

### 13.12 Monitoring

- **Metrics:** Prometheus (scrape) → Thanos for long-term & global view.
- **RED metrics** (Rate, Errors, Duration) per service per endpoint.
- **USE metrics** (Utilization, Saturation, Errors) per resource (CPU, memory, disk, network).
- **Business metrics:** active users, workflow throughput, document uploads, etc.

### 13.13 Blue-Green Deployment

- **Argo Rollouts** with blue-green strategy for high-risk services.
- **Pre-flight verification:** smoke tests against the new version before traffic shift.
- **Instant rollback:** flip back to old version in seconds.
- **Database migrations:** expand-contract pattern (backward-compatible expand → deploy code → contract removal of old).

### 13.14 Security Scanning

- **SAST:** Semgrep (open-source rules) and CodeQL (free for open source / on-prem self-hosted via GitHub Advanced Security alternative — or `osv-scanner`) in CI.
- **Dependency scanning:** Renovate (self-hosted, MIT) for upgrade automation; OWASP Dependency-Check; Trivy filesystem scan; OSV-Scanner.
- **Container scanning:** Trivy, Grype, Clair — all open source.
- **Runtime scanning:** Falco (CNCF) for Kubernetes runtime anomaly detection.
- **DAST:** OWASP ZAP (open source) on staging environments.
- **Penetration testing:** periodic engagement with internal security team or one-time external assessments — no recurring subscriptions.

**Excluded:** Snyk, Veracode, Checkmarx, Burp Suite Enterprise, and other SaaS or per-seat-licensed scanners. All security tooling is open-source and self-hosted.

---

## 14. OBSERVABILITY & MONITORING

### 14.1 Metrics

- **Prometheus** as the metric backbone.
- **Histogram** of latencies (P50, P95, P99 derivable).
- **Per-service dashboards** standardized — RED + dependencies + saturation.
- **Per-tenant breakdown** for tenant-aware troubleshooting (high-cardinality label management with Mimir or Thanos).

### 14.2 Tracing

(Covered in §13.11.) Full distributed tracing for every request through every service; visualizable in Grafana / Jaeger.

### 14.3 Logs

(Covered in §13.10.) Centralized, structured, queryable, correlated.

### 14.4 Alerting

- **Alertmanager** (Prometheus) → routing rules → internal Notification System (§3.13) → email + web push + in-platform alert.
- **On-call scheduling:** self-hosted (e.g., Grafana OnCall — open source, Apache 2.0).
- **Severity levels:** SEV1 (paging immediately), SEV2 (paging during business hours), SEV3 (ticket), SEV4 (informational).
- **Alert hygiene:** every alert has a runbook link; alerts that don't have actionable response are deleted.
- **Alert fatigue prevention:** aggregation, inhibition rules, maintenance windows.

**Excluded:** PagerDuty, Opsgenie, VictorOps, xMatters, Splunk On-Call, and any other paid SaaS paging service. All paging routes through self-hosted infrastructure.

### 14.5 Audit Monitoring

- Audit log tail-fed to the internal SIEM in real time.
- Detection rules for suspicious patterns (mass deletion, privilege escalation, off-hours admin).
- Investigations workflow (case management module).

### 14.6 SIEM Integration

- **Internal SIEM stack (default):** Wazuh (open source) or the Elastic SIEM / OpenSearch Security Analytics plugin — both self-hosted and free.
- **Forwarder:** Vector or Fluent Bit (both CNCF / open source).
- **Format:** Syslog (RFC 5424) and CEF — open standards readable by any conforming SIEM.
- **Optional outbound integration:** if a tenant operates their own commercial SIEM (already licensed by them, e.g., Splunk on-prem), the platform exports audit via syslog/CEF — but the platform itself does not require or subscribe to any commercial SIEM.

**Excluded as platform dependencies:** Splunk Cloud, Microsoft Sentinel, IBM QRadar, Sumo Logic, Datadog Cloud SIEM, and similar SaaS SIEMs.

### 14.7 Operational Dashboards

- **Platform health dashboard:** all services, all dependencies, color-coded status.
- **Tenant-centric dashboard:** per-tenant SLO compliance.
- **Module-specific dashboards:** auth, workflow, GIS, search — each with deep-dive metrics.
- **Incident dashboard:** active incidents with timeline and ownership.

### 14.8 Health Checks

- **Liveness probe:** "am I alive" — process-level.
- **Readiness probe:** "am I ready to serve" — dependencies up.
- **Startup probe:** for slow-starting services.
- **Deep health endpoint:** authoritative status of dependencies (DB, cache, broker).
- **Synthetic monitoring:** end-to-end probes from external vantage point (e.g., login flow every 5 min).

---

## 15. PERFORMANCE & SCALABILITY

### 15.1 Horizontal Scaling

- **Stateless services** (REST API, BFF, WebSocket gateway, workers) scale linearly.
- **Stateful services** (DB, broker) scale via well-known patterns:
  - **PostgreSQL:** read replicas → Citus sharding → per-tenant shards.
  - **ClickHouse:** native sharding + replication.
  - **NATS/Kafka:** native partitioning.
  - **Redis:** Cluster mode with hash slots.

### 15.2 Caching

- **L1 (process-local):** LRU cache for hot read-mostly data.
- **L2 (Redis):** distributed cache with TTL and event-driven invalidation.
- **L3 (CDN):** for public assets and tile data.
- **Cache key namespacing:** `tenant:{id}:domain:{name}:resource:{id}` — prevents cross-tenant key collision.
- **Cache invalidation:** event-driven via NATS subjects — when a resource changes, an invalidation event is published.

### 15.3 Distributed Systems Concerns

- **CAP** awareness: most reads available under partition (AP); writes consistent (CP). Per-domain tradeoffs documented.
- **Backpressure** at every queue boundary.
- **Bulkheads:** dedicated thread pools / connection pools per dependency to prevent one slow dependency from saturating the service.
- **Circuit breakers** at every external call (Resilience4j-style).
- **Timeouts** at every level (no infinite waits).
- **Idempotency** as design default.

### 15.4 High-Load GIS

- Tile pre-generation for hot zooms.
- CDN at the edge.
- Read replicas for tile generation.
- Per-tenant tile cache namespace.
- Geometry simplification by zoom (precomputed columns).
- Vector tile generation budget: ≤200ms P95 per tile (cold), ≤20ms (warm).

### 15.5 Analytics Scaling

- ClickHouse columnar engine — designed for OLAP scale.
- Materialized views collapse expensive aggregations.
- Projections for alternative sort orders.
- Distributed query fan-out across shards.
- Query result cache for identical query reuse.

### 15.6 WebSocket Scaling

- Sticky sessions at LB.
- Per-instance connection budget (50k typical).
- Cross-instance fan-out via Redis Pub/Sub or NATS.
- Connection eviction on backpressure (configurable per role).

### 15.7 Search Scaling

- Index sharding by tenant + time.
- Hot/warm/cold tier data lifecycle.
- Read-only replicas for search burst capacity.
- Per-query cost limits (timeout, max docs scanned).

### 15.8 Large File Handling

- Direct browser-to-object-storage upload (no API proxy).
- Resumable upload (tus.io).
- Chunked download with range requests.
- Streaming preview generation (don't buffer entire file in memory).

### 15.9 Multi-Region

- **Day 1:** single region.
- **Horizon 2:** active-passive across two regions for DR.
- **Horizon 3:** active-active with selective replication. Per-domain replication strategy:
  - **Identity:** global, eventually consistent.
  - **Audit:** regional (sovereignty); cross-region replication only if regulated allowed.
  - **Tenant data:** primary-region pinned; cross-region read replicas for collaboration with users abroad.

### 15.10 Capacity Planning

- **Load testing** quarterly with k6 or Gatling — full-stack scenarios at projected peak load + 50%.
- **Chaos engineering** (Chaos Mesh, Litmus) — periodic injection of failures (node loss, network partition, DB primary failure) to validate resilience.

---

## 16. AI-READY ARCHITECTURE

### 16.1 Why "AI-Ready" Is a Day-0 Concern

AI capabilities will be added incrementally, but the data and infrastructure substrate must be designed up-front to enable them without rewriting. Specifically:
- Every document, message, and case has stable IDs and structured metadata.
- Every event captures the surface area future AI will need (timestamps, actors, content, context).
- Vector storage and embedding pipelines are infrastructure primitives, not afterthoughts.

### 16.2 AI Copilots

- **Copilot abstraction:** a system role in conversations and on contextual UI surfaces.
- **Per-module copilots:** GIS copilot ("show me all assets in flood-prone zones with active maintenance tickets"), document copilot (summarize, extract, compare), workflow copilot (suggest next step).
- **Action grounding:** copilot proposes actions; user confirms; the platform executes via standard APIs (no special "AI side channel").

### 16.3 Semantic Search

- **Embedding pipeline:** every document, message, case, wiki page → embedding via **self-hosted open-weight models** served by the LLM gateway (e.g., `bge-m3`, `e5-large`, `nomic-embed-text`, `multilingual-e5` — all openly licensed, deployable on internal GPU/CPU infrastructure).
- **Storage:** Qdrant (Apache 2.0, self-hosted) or pgvector (PostgreSQL extension, open source) for low-volume.
- **Query:** hybrid search — BM25 + vector kNN, results fused with reciprocal rank fusion or learned ranker.
- **Permission-aware:** post-filter or pre-filter by ABAC at retrieval time.

### 16.4 Vector Databases

- **Qdrant:** preferred for production — purpose-built, performant, supports hybrid search, payload filtering.
- **pgvector:** acceptable for low-volume (<10M vectors) and when team prefers single-DB simplicity.
- **Milvus:** for billion-scale — overkill at MVP, candidate at Horizon 3.

### 16.5 Document Intelligence

- **Classification:** auto-tag documents by content (regulation, contract, report, etc.).
- **Entity extraction:** organizations, persons, dates, monetary amounts, locations.
- **Relationship extraction:** "Document X references Regulation Y; Regulation Y supersedes Z."
- **Summarization:** abstractive summaries for long documents.
- **Question answering** over corpora via RAG.

### 16.6 OCR

- **Tesseract** (open source, Apache 2.0) — primary OCR engine.
- **PaddleOCR** (open source) — strong multilingual support, including CJK and handwriting; self-hosted.
- **docTR** (open source, Mindee) — modern OCR for layout-heavy documents.
- **Pipeline:** image upload → OCR worker (CPU or self-hosted GPU) → text → indexed in OpenSearch + embedded in vector DB.
- **PDF OCR:** for scanned PDFs (no embedded text) — same self-hosted pipeline.

**Excluded:** AWS Textract, Google Cloud Vision, Azure Document Intelligence, ABBYY Cloud OCR, and any other per-page-billed OCR service.

### 16.7 AI Analytics

- **Anomaly detection:** time-series outlier detection on operational metrics (Prophet, ARIMA, isolation forest, or LLM-driven for natural-language queries).
- **Predictive analytics:** forecast workflow completion times, asset failure, demand.
- **Causal inference (selectively):** "what factors most contributed to this incident?"

### 16.8 LLM Integrations

- **LLM gateway:** abstraction layer for interchangeable **self-hosted open-weight models** served via vLLM, llama.cpp server, Ollama, or Text Generation Inference (TGI). Supported model families include Llama 3.x, Mistral / Mixtral, Qwen, DeepSeek, Phi, Gemma — all openly licensed and runnable on internal GPU infrastructure.
- **Routing logic:** task → model (e.g., simple summarization → smaller model on CPU/small GPU; complex reasoning → larger model on multi-GPU node).
- **Resource management:** per-tenant rate limits, GPU queue scheduling, fair-share — for capacity governance, not billing.
- **Prompt management:** versioned, A/B testable, audit-logged prompts.
- **Caching:** semantic cache for similar queries (reduces internal compute load).
- **PII redaction:** outbound prompts (even to self-hosted models) scrubbed of sensitive data per tenant policy.

**Excluded as platform dependencies:** OpenAI API, Anthropic API, Cohere API, Google Vertex AI, AWS Bedrock, Azure OpenAI, and any other per-token-billed inference service. The platform's AI capabilities run on self-owned infrastructure — sovereign, predictable in cost, and free of recurring per-call charges.

### 16.9 RAG Architecture

```
User query
  → Query embedding
    → Vector search (top-k chunks) + BM25 search → fusion
      → Permission filter (post-filter against user ABAC)
        → Context assembly (selected chunks + system prompt)
          → LLM call
            → Response with citations to source chunks
              → Audit log (query, retrieved chunks, response, cost)
```

- **Chunking strategy:** semantic chunking (paragraph-aware) for documents; per-message for chat; per-section for wiki.
- **Re-ranking:** cross-encoder re-rank top-50 → top-5 for higher precision.
- **Citation enforcement:** prompt requires citation for every claim; UI shows sources prominently.
- **Hallucination mitigation:** retrieval-grounded generation; confidence scoring; flag low-confidence answers.

### 16.10 Recommendation Systems

- **Content recommendations:** "documents similar to this," "users who viewed X also viewed Y."
- **Workflow recommendations:** suggest next workflow step based on similar cases.
- **Implementation:** vector similarity + collaborative filtering + business rules.

### 16.11 AI Safety & Governance

- **Audit:** every LLM call logged (prompt, response, model, latency, GPU-seconds consumed for capacity planning).
- **Approval workflows:** AI-suggested actions require user confirmation before execution.
- **Data residency:** all inference happens on the platform's own infrastructure — data never leaves the deployment boundary; full sovereignty by construction.
- **Bias monitoring:** sample audits of AI outputs for fairness and accuracy.
- **Model versioning:** changes to model or prompt versioned with rollback capability.
- **Red-teaming:** adversarial testing of AI features pre-release.

---

## 17. DEVELOPMENT ROADMAP

### Phase 1 — Foundation Platform (Months 0–6)

**Objectives:** Establish the architectural skeleton and the modules without which nothing else works.

**Architecture priorities:**
- Identity & Access Management (full).
- Multi-tenancy (logical isolation, RLS).
- RBAC/ABAC (RBAC fully, ABAC scaffolding).
- Audit & Activity Logging.
- API Gateway + BFF.
- Notification System (in-platform + email).
- Administration Panel (basic).
- Frontend shell (workspace, navigation, design system).
- Observability (metrics, logs, traces, alerting).
- CI/CD, IaC, K8s base infrastructure.
- File Management (basic — folders, upload, download, sharing).
- Search Engine (foundation — keyword search across documents, messages).

**Dependencies:** None — this is the foundation.

**Engineering complexity:** Medium-high. The IAM/RBAC/ABAC/audit triumvirate is dense; the multi-tenant architecture must be perfect from day one (retrofitting tenant isolation later is a nightmare).

**Risks:**
- IAM-related security flaws compound across the platform — invest in expert review.
- Multi-tenancy shortcuts are catastrophic later.
- Underinvestment in observability at this stage causes blind operations later.

**Estimated timeline:** 6 months with a team of ~12–18 engineers.

---

### Phase 2 — GIS + Analytics (Months 6–12)

**Objectives:** Deliver the analytical and spatial capabilities that differentiate the platform.

**Architecture priorities:**
- GIS module (full — layers, vector tiles, spatial queries, geofencing, basic spatial analytics).
- Realtime Event System (production-grade, with outbox, idempotent consumers).
- Analytics module (ClickHouse projections, dashboards, ad-hoc query within governance).
- Dashboard Builder.
- Data Import/Export (basic — CSV, GeoJSON, Shapefile).
- Monitoring & Observability extensions for GIS and analytics workloads.

**Dependencies:** Phase 1 platform foundation must be stable.

**Engineering complexity:** High. GIS is its own discipline; tile rendering and caching are non-trivial; spatial query optimization requires deep PostGIS expertise; analytical query design requires deep ClickHouse/SQL expertise.

**Risks:**
- GIS performance under load is hard to predict — invest in load testing early.
- ClickHouse misuse (treating it like PostgreSQL) leads to terrible performance — invest in training.

**Estimated timeline:** 6 months.

---

### Phase 3 — Document Management + Workflows (Months 12–18)

**Objectives:** Deliver structured document lifecycle and orchestrated business processes.

**Architecture priorities:**
- Enterprise Document Management (lifecycle, versioning, classification, retention).
- File Management extensions (advanced previews, versioning, retention).
- Workflow / BPM Engine (Temporal integration; visual builder MVP).
- Task & Case Management.
- Knowledge Base / Wiki.
- Integration Gateway external API (full external API surface).

**Dependencies:** Phase 1 (auth, audit) and Phase 2 (events, dashboards for workflow analytics).

**Engineering complexity:** High. Workflow engines impose architectural constraints; document lifecycle compliance is detail-heavy; legal-hold and retention require careful auditability.

**Risks:**
- Workflow engine choice has long-term implications — validate Temporal at scale before committing.
- Document compliance requirements vary per tenant — design configuration surface broadly.

**Estimated timeline:** 6 months.

---

### Phase 4 — Collaboration + Realtime Systems (Months 18–24)

**Objectives:** Native collaboration — chat, video, real-time editing, presence.

**Architecture priorities:**
- Realtime Collaboration (CRDT-based co-editing across documents, dashboards, wiki).
- Chat & Messaging.
- Video Conferencing (LiveKit integration).
- Operational Monitoring Center.
- Incident / Event Management.
- Media Management (transcoding, streaming).
- WebSocket infrastructure scaling validation.

**Dependencies:** Phase 1–3 stable.

**Engineering complexity:** Very high. Realtime systems are subtle (presence, ordering, reconnect, scale); video infrastructure requires specialized expertise (TURN/STUN, SFU operations, bandwidth management); CRDTs require careful integration.

**Risks:**
- Video infrastructure is a different operational discipline; consider a dedicated team or initial managed-service approach.
- WebSocket scaling under realistic peak load needs early validation.

**Estimated timeline:** 6 months.

---

### Phase 5 — AI Integrations (Months 24–30)

**Objectives:** Bring AI capabilities to production — copilots, semantic search, document intelligence, RAG.

**Architecture priorities:**
- LLM Gateway.
- Vector database integration.
- Embedding pipeline.
- Semantic search (production).
- Per-module copilots.
- Document intelligence (classification, extraction, summarization).
- OCR pipeline.
- RAG framework with citation.
- AI safety, audit, governance.

**Dependencies:** Phase 1–4.

**Engineering complexity:** High but well-scoped if substrate is in place. Most complexity moves from infrastructure to evaluation, prompt engineering, and governance.

**Risks:**
- GPU capacity planning — self-hosted inference requires sizing GPU fleets to peak demand; throttling and queueing policies required.
- Hallucination and accuracy in regulated contexts.
- Model selection drift — the open-weight model landscape moves quickly; evaluation harness required to swap models without regression.
- Rapid pace of AI tooling — pick abstractions carefully to avoid lock-in to specific runtimes (vLLM vs TGI vs Ollama).

**Estimated timeline:** 6 months.

---

### Continuous (All Phases)

- Security hardening and pentesting.
- Performance optimization.
- Documentation.
- DR drills.
- Compliance audits.
- Customer feedback integration.

---

## 18. RISK ANALYSIS

### 18.1 Architectural Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Premature decomposition into microservices | Operational complexity, distributed-systems debt | Modular monolith with clean boundaries; extract services only when justified by team or load |
| Underspecified module contracts | Coupling, breaking changes, integration failures | Contract-first development; OpenAPI/AsyncAPI versioned; consumer-driven contract tests |
| Multi-tenancy retrofit | Catastrophic — re-architect required | Tenant context as Day-0 architectural primitive; RLS on every table |
| Database as integration point | Coupling, performance issues, schema explosion | Module-owned data; cross-module by API/event only |

### 18.2 Scalability Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Unbounded query patterns | DB hot spots, resource exhaustion | Query budget enforcement; mandatory pagination; ClickHouse for analytical |
| WebSocket scale ceiling | Service degradation at peak | Early load testing; Redis Pub/Sub for cross-instance fanout; capacity planning |
| Tile generation bottleneck | Map loading slow, UX degradation | CDN caching; pre-generation; geometry simplification |
| Search index growth | Cluster pressure, slow queries | Time-based index rolling; hot/warm/cold tiers; per-tenant indices |

### 18.3 GIS Complexity

| Risk | Impact | Mitigation |
|---|---|---|
| Geometry data quality | Failed spatial queries, incorrect analytics | Validation pipeline; `ST_IsValid` checks; quarantine queue |
| Coordinate system confusion | Wrong-position bugs (degrees vs meters; datum mismatch) | Canonical WGS84 storage; explicit type system; reprojection at boundary |
| Spatial index tuning | Slow queries on large datasets | GIST + BRIN; partitioning; expert review |
| Tile cache invalidation | Stale data on map | Event-driven tag-based invalidation; testing |

### 18.4 Realtime Complexity

| Risk | Impact | Mitigation |
|---|---|---|
| Event ordering issues | Inconsistent state, race conditions | Per-aggregate ordering; idempotent consumers; vector clocks where needed |
| Lost events during failures | Data inconsistency | Outbox pattern; durable broker; consumer offset commit discipline |
| Reconnect storms | Service overload after network blip | Exponential backoff; randomized jitter; rate limits |
| Cross-instance coordination | Missed messages | Redis Pub/Sub or NATS for fan-out; presence convergence on reconnect |

### 18.5 Video Infrastructure Complexity

| Risk | Impact | Mitigation |
|---|---|---|
| TURN bandwidth saturation | Degraded media quality | Capacity plan; aggressive STUN to maximize P2P; regional TURN nodes |
| SFU failure cascades | Meeting disruption | Multiple SFU nodes; auto-rebalance; client reconnect logic |
| Recording storage growth | Disk capacity exhaustion | Retention policy; tiered storage (hot SSD → cold object storage); codec selection |
| Specialized expertise required | Slow incident response | Cross-train; runbooks; in-house WebRTC ownership from day one |

### 18.6 Organizational Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bus-factor on critical components | Knowledge silos, incident response gaps | Pair-programming; documentation; rotation |
| Misaligned team boundaries | Delivery friction | Conway's-law-aware org design; module ownership |
| Skill gaps in specialized areas | Quality issues | Hiring or partnerships for GIS, video, security |
| Roadmap pressure leading to architectural shortcuts | Long-term debt | Architecture review board with veto power on principle violations |

### 18.7 Technical Debt Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Skipped tests, deferred refactoring | Compounding maintenance burden | "Boy Scout rule" enforced; debt ledger reviewed quarterly; capacity for tech debt in every sprint |
| Outdated dependencies | Vulnerabilities, EOL | Renovate/Dependabot; quarterly version review |
| Custom code where library exists | Maintenance burden | Build vs buy review for non-differentiating components |
| Schema sprawl | Complexity, slow queries | Migration review; periodic schema audit |

### 18.8 Security Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Tenant isolation breach | Catastrophic data leak | RLS on every table; periodic audit; pentesting |
| Token theft | Account compromise | Short-lived tokens; refresh rotation; device fingerprint |
| Privilege escalation | Unauthorized access | ABAC; audit; principle of least privilege |
| Third-party dependency CVEs | Compromise | SBOM; scanning; rapid patch SLA |
| AI prompt injection | Unauthorized actions, data leak | Strict prompt boundaries; output validation; user confirmation for actions |

---

## 19. TEAM STRUCTURE

### 19.1 Engineering Organization

**Total target staffing for full Horizon-1 delivery:** ~50–70 engineers across 4 phases of growth.

```
┌─────────────────────────────────────────────────────────┐
│                       CTO                               │
│                        │                                │
│        ┌───────────────┼───────────────┐                │
│        │               │               │                │
│  Architecture     Engineering      Security             │
│   Council         Directors         Director            │
└─────────────────────────────────────────────────────────┘

       Engineering Directors oversee:
       - Backend Platform Group
       - Frontend Group
       - GIS & Geospatial Group
       - Realtime & Communications Group
       - Data & Analytics Group
       - DevOps / SRE Group
       - QA Group
       - AI / ML Group (Phase 5)
```

### 19.2 Backend Team

**Size:** 10–14 engineers

**Structure:**
- **Platform Backend** (5–7) — IAM, RBAC, multi-tenancy, audit, API gateway, notifications.
- **Domain Backend** (5–7) — workflow, documents, cases, chat business logic.

**Skills:**
- Senior NestJS/TypeScript expertise.
- Distributed systems fundamentals.
- PostgreSQL deep knowledge.
- Event-driven architecture.

### 19.3 Frontend Team

**Size:** 8–12 engineers

**Structure:**
- **Platform Frontend** (3–4) — design system, shell, navigation, command palette.
- **Module Frontend** (5–8) — module-specific UI (dashboards, map, chat, documents).

**Skills:**
- Senior Next.js/React/TypeScript.
- Accessibility expertise.
- Performance engineering.
- Design system fluency.

### 19.4 GIS Specialists

**Size:** 3–5 engineers (PhD-level depth recommended for at least 1)

**Skills:**
- PostGIS, spatial SQL.
- MapLibre, vector tile pipelines.
- Spatial analytics (geostatistics, routing).
- Coordinate systems / cartography.

### 19.5 DevOps / SRE

**Size:** 5–8 engineers

**Structure:**
- **Platform Engineering** (3–4) — K8s, IaC, CI/CD, baseline observability.
- **SRE** (2–4) — on-call, reliability engineering, capacity planning, chaos engineering.

**Skills:**
- Kubernetes deep operations.
- Terraform, Helm, Argo CD.
- Observability (Prometheus, Grafana, Loki, Tempo).
- Incident command.

### 19.6 QA Team

**Size:** 5–8 engineers

**Structure:**
- **Test Automation** (3–4) — E2E framework, integration tests, contract tests.
- **Performance** (1–2) — load testing, stress testing.
- **Manual / Exploratory** (1–2) — exploratory testing, UX validation.

### 19.7 Security Engineering

**Size:** 3–5 engineers

**Skills:**
- AppSec / threat modeling.
- DevSecOps (security in pipeline).
- Identity / cryptography.
- Compliance (SOC2, ISO27001, GDPR).

**Reports to:** Security Director (independent reporting line for governance).

### 19.8 Architecture Governance

**Architecture Review Board (ARB):**
- Chief Architect (chair).
- One senior engineer per major group (rotating).
- Security architect.
- Reviews:
  - All cross-module API contracts.
  - All new external dependencies.
  - All architectural deviations from documented patterns.
  - All multi-tenancy and security-sensitive changes.
- Authority: veto power on principle violations; advisory on tradeoffs.

### 19.9 Realtime & Communications Team (Phase 4 onward)

**Size:** 3–5 engineers (specialized)

**Skills:**
- WebRTC / SFU operations.
- Yjs / CRDT.
- WebSocket scaling.

### 19.10 Data & Analytics Team

**Size:** 4–6 engineers

**Skills:**
- ClickHouse expertise.
- ETL/ELT pipelines.
- Streaming systems (Kafka/NATS).
- Analytics engineering.

### 19.11 AI / ML Team (Phase 5)

**Size:** 4–8 engineers

**Skills:**
- LLM application engineering.
- Embedding / vector search.
- Prompt engineering / evaluation.
- ML systems engineering.

---

## 20. FINAL ARCHITECTURE RECOMMENDATIONS

### 20.1 Architectural Principles (Non-Negotiable)

1. **Tenant context is structural.** Every query, every cache key, every log entry, every event carries `tenant_id`. Cross-tenant access is impossible by construction, not by convention.

2. **Identity is the edge.** Every request authenticated; every action authorized; every decision logged. There is no internal trusted zone.

3. **State of record is singular.** PostgreSQL owns the truth for transactional state. ClickHouse, OpenSearch, Redis, vector DB, object storage are derived caches/projections — rebuildable from PostgreSQL + event log.

4. **Events are first-class.** Every domain mutation produces a versioned, schema-validated event. Events are observable, replayable, and durable.

5. **Modules own their data.** No cross-module foreign keys. Cross-module references resolved by ID through API or event.

6. **Idempotency is the default.** Every command handler, every event consumer is idempotent. Retries are safe.

7. **Observability is built-in.** No service ships without metrics, logs, traces, health endpoints. "Untraced is unfinished."

8. **Schema is contract.** Every API, every event, every table change is reviewed and versioned. Breaking changes require version bump.

9. **Failure is normal.** Every external call has timeout, retry, circuit breaker. No service can take down the platform.

10. **Operational toil is automated.** Manual production access is exceptional and audited. Runbooks are scripts.

11. **No paid third-party runtime dependencies.** The platform runs entirely on open-source, self-hosted infrastructure. Excluded categories — at the platform level — include:
    - Per-message billed services (SMS gateways, paid push relays, telephony/SIP trunks).
    - Per-token / per-call billed AI APIs (OpenAI, Anthropic, Cohere, hosted Bedrock/Vertex/Azure OpenAI).
    - Per-page billed OCR APIs (Textract, Cloud Vision, Document Intelligence).
    - SaaS paging and on-call services (PagerDuty, Opsgenie, VictorOps).
    - SaaS SIEM (Splunk Cloud, Sentinel, QRadar, Datadog SIEM).
    - Commercial workflow runtimes with cloud licensing (Camunda 8, Temporal Cloud).
    - Commercial enterprise editions of OSS components (AG Grid Enterprise, etc.).
    - SaaS security scanners with per-seat licensing (Snyk, Veracode, Checkmarx).
    - End-user subscription/billing logic — the platform is **not a SaaS that bills its users**; it is enterprise/government software deployed for an organization. There is no Stripe, no payment processor, no plan/tier/quota-charging logic. Resource quotas exist for capacity governance only.

### 20.2 Anti-Patterns to Avoid

- **Microservices premature decomposition.** Start as a modular monolith. Extract only when justified by team, load, or deployment cadence — not by architectural fashion.

- **Database as integration mechanism.** Never share tables across modules. Use APIs and events.

- **Distributed transactions across modules.** Use sagas with compensations. 2PC is not a tool you'll need.

- **Synchronous chains.** Avoid `Service A → calls → Service B → calls → Service C → calls → Service D` synchronous chains. Each link multiplies latency and failure probability.

- **Shared mutable state via cache.** Cache is read-through; mutations go through the system of record.

- **Tenant ID via header trust.** Tenant ID derives from the validated token, not from a header the client could spoof.

- **Bypassed RLS via "for performance."** Performance issues with RLS are solved with indexing and query design, not by disabling RLS.

- **AI as opaque side channel.** AI features use the same APIs and audit trail as everything else. Suggested actions still go through standard authorization.

- **"We'll add observability later."** Later doesn't come; instrument from day one.

- **"We'll write tests later."** Same problem.

- **Custom auth.** Use OIDC. Don't write your own session handling, password hashing, MFA flow.

- **Premature internationalization shortcuts.** If multi-language is in roadmap, externalize strings from day one.

### 20.3 Scaling Strategy

**Stage 1 (0–10K users):**
- Single region, single PostgreSQL primary + 2 replicas, single ClickHouse cluster (3 shards × 2 replicas), single NATS cluster, single Redis cluster.
- Single Kubernetes cluster.
- Vertical scaling first; add read replicas as read load grows.

**Stage 2 (10K–100K users):**
- Multi-region active-passive for DR.
- PostgreSQL sharding via Citus when single-node ceiling approaches.
- Per-tenant index strategy in OpenSearch.
- WebSocket gateway horizontal scale with Redis Pub/Sub.
- Tile CDN globally.

**Stage 3 (100K+ users):**
- Multi-region active-active for high-traffic tenants.
- Per-tenant dedicated infrastructure for sovereign / mega tenants.
- Federated event bus across regions.
- Edge compute for latency-sensitive operations (Cloudflare Workers, AWS Lambda@Edge).

### 20.4 Migration Strategy

**For existing-system replacement projects:**

1. **Strangler Fig pattern:** new platform stands alongside legacy; specific modules migrate one at a time; routing layer (gateway) directs traffic per-feature.
2. **Data migration:** dual-write phase (legacy + new) → backfill → cut-over → decommission.
3. **User migration:** SSO bridge from legacy to new; phased per-department.
4. **Feature parity gate:** never decommission legacy until 100% feature parity + 30-day stability + user satisfaction validated.

### 20.5 Enterprise Implementation Guidance

**For procurement and stakeholder alignment:**

- **Pilot strategy:** Phase 1 deployment to a pilot department for 3 months before broad rollout. Pilot validates UX, training, integrations, and operational fit.
- **Training:** invest 5% of project budget in training (admins, end users, IT operators). Adoption fails on training, not technology.
- **Change management:** dedicated change management team running parallel to engineering. The platform changes how people work; this is an organizational program, not just IT.
- **Integration inventory:** before Day 1, document every system the platform must integrate with (HRIS, ERP, identity, finance, legacy custom apps). Integration is where projects bog down.
- **Compliance pre-engagement:** engage legal, compliance, and audit early. Their requirements shape architecture (data residency, retention, audit detail).

### 20.6 Long-Term Platform Evolution Strategy

**3-year horizon:**
- Module extraction: high-load modules (GIS, search, video) extracted to dedicated services.
- Multi-region active-active.
- Marketplace: third-party plugins, custom modules per tenant.
- API ecosystem: external integrators build on the platform.

**5-year horizon:**
- AI-native: AI deeply embedded; user-facing copilots in every module; agentic workflows.
- Federation: cross-organization collaboration at the platform level.
- Sovereign deployments: airgapped deployable, self-contained.
- Edge intelligence: local inference, edge caching, low-latency operations at the edge of the network.

**Architectural posture for evolution:**
- Decisions made today must not preclude tomorrow's options.
- Avoid lock-in to single cloud, single LLM provider, single SFU vendor.
- Invest in abstractions where evolution is likely (LLM gateway, storage abstraction, identity federation).
- Avoid abstractions where they add cost without clear evolution (premature framework abstractions, "configurable everything").

### 20.7 Closing Synthesis

The platform succeeds when three properties hold simultaneously:

1. **It is one platform, not a federation of glued tools.** A user logs in once, navigates one workspace, and sees coherent data across map, dashboard, document, chat, workflow, search.

2. **It is engineering-honest.** No hidden complexity, no unjustified abstractions, no fashion-driven choices. Every architectural decision is defensible against scrutiny by a senior engineer who has not been part of the team.

3. **It is operationally accountable.** Every action is observable, every decision auditable, every failure recoverable, every change reversible.

These are the metrics by which the architecture should be evaluated, not feature counts or technology buzzwords.

---

**END OF DOCUMENT**

---

**Document Maintenance**

This specification is a living document. Major architectural decisions, deviations, and learnings should be recorded as Architecture Decision Records (ADRs) referenced from this document. Quarterly reviews by the Architecture Review Board are mandatory; annual full revisions are expected. The version history of this document, the ADRs, and the related RFCs constitute the long-term architectural memory of the platform.
