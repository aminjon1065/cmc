# CMC — Crisis Management Center Platform

## Technical Requirements (Scoped)

**Owner organization:** Committee for Emergency Situations and Civil Defense of the Republic of Tajikistan (КЧС ГО РТ)
**Document type:** Technical Requirements — implementation target
**Version:** 2.0 (supersedes v1.0)
**Status:** Accepted

> **What changed from v1.0.** v1.0 specified a multi-tenant, multi-region,
> nationally-federated SaaS platform sized for 100,000 concurrent users and 10¹⁰
> records, with ClickHouse, NATS/Kafka, Temporal, OpenSearch, a vector/RAG/copilot
> AI stack, in-house video conferencing, collaborative editing, and a plugin
> marketplace. That is the specification of a different product.
>
> This platform is an **internal tool for one organization** — КЧС ГО РТ — running
> on **its own single server**, used primarily by **analysts** and operational
> staff, with access scoped **across the republic by region/subdivision**. There
> is **one tenant**. v2.0 keeps the sound engineering core already built and
> removes everything that only makes sense for a multi-tenant national SaaS.
> The full removal list is §2. Removed capabilities are not lost — they are
> recorded in §12 with the condition under which each returns.

---

## 1. Purpose & Scope

The platform is a single, coherent workspace for КЧС ГО РТ that unifies:

- **Analytical work on emergency data** — collection, filtering, sorting, risk
  analysis, report generation. This is the primary value; analysts are the
  primary users.
- **Geospatial intelligence** — emergency maps over PostGIS, usable both in the
  web UI and by external desktop GIS (QGIS, ArcGIS) via standard OGC services.
- **Electronic document management (EDMS / СЭД)** — document lifecycle, versions,
  retention, approvals, with a hierarchical file manager.
- **Operational coordination** — incidents and cases, task delegation along the
  organizational hierarchy (chief → subordinate), notifications.
- **Internal communication** — chat and notifications now; audio/video later via
  an integrated self-hosted server (not built in-house).
- **Discovery** — fast full-text search across platform objects.

Everything runs **on-premise** on infrastructure controlled by КЧС. No data
leaves the organization's server. No paid per-call third-party runtime
dependencies.

---

## 2. Explicit Non-Goals (deliberately NOT built now)

These were in v1.0 and the initial code skeleton. They are removed from the build
target. Building them now would spend the majority of effort on infrastructure
that serves zero current users and would make the system harder for a small team
to operate and reason about.

| Removed / deferred | Why it does not belong now |
|---|---|
| **Multi-tenancy** (`tenants`, tenant branding, per-tenant `tenant_id`, tenant RLS, per-tenant encryption keys) | There is exactly **one** organization. Tenant isolation solves a problem that does not exist here. Organizational scoping across the republic is handled by **regions** (§4), not tenancy. |
| **Multi-region / active-active / federation / sovereign multi-deploy** | One server, one site. High availability and backups are still required (§9), but cross-region replication and federation are not. |
| **Temporal** (durable workflow engine) | The few approval/SLA flows the platform needs are modeled in-app (DB state + scheduled jobs). A separate durable-workflow runtime is operational weight without payoff at this scale. |
| **NATS / Kafka event bus** | Cross-module reactions run on an **in-process event emitter**. A network broker is added only if and when a module is extracted into a separate service. |
| **ClickHouse (OLAP)** | Analytics run on **PostgreSQL** to start. ClickHouse returns later, if and only if Postgres aggregation latency on real data becomes the bottleneck, and then only as a **read-only downstream analytics/log sink** — never the system of record, never under EDMS. |
| **AI stack** — LLM gateway, vector pipeline, semantic search, RAG, copilot, document intelligence | The AI-based emergency forecasting is explicitly a *later* goal. `pgvector` stays available in Postgres so embeddings can be added later without a new datastore, but no AI module ships now. |
| **In-house video conferencing & media pipeline** | Audio/video, group meetings, and recording are a large separate product. When needed, integrate a **self-hosted Jitsi (+ Jibri for recording)**, on-prem. Not built in-house. |
| **Real-time collaborative document editing** | Out of scope for v2.0. Versioned documents + locking are sufficient. |
| **OpenSearch + federated search** | **PostgreSQL full-text search** covers discovery at this scale. OpenSearch returns only if FTS proves insufficient on real data volume. |
| **Visual workflow builder, wiki/knowledge base, API-key platform, PWA mobile companion** | None are core to the analyst mission. Deferred; revisit per §12. |
| **SOC2 / enterprise-SaaS compliance program** | КЧС is a single government body, not a SaaS vendor. The relevant requirements are Tajik government/legal ones (auditability, on-prem data residency, retention) — already covered by §10. SOC2 control mapping is removed. |
| **Heavy observability stack** (distributed tracing, Tempo, Loki) | Kept lightweight: structured logs + Prometheus metrics + health probes. Full distributed tracing is added only when there is load that justifies it. |

**Anti-scope-creep rule:** nothing in this table is added back without an ADR that
states the concrete trigger (real data volume, a real user need, an extraction
decision) that justifies it. "It would be nice / the platform should support it"
is not a trigger.

---

## 3. Users & Roles

- **Analysts (primary).** Work with data, run risk analysis and forecasting
  inputs, build and export reports, operate the map, manage layers.
- **Operational staff.** Report and handle incidents and cases, receive and act
  on task delegations, communicate.
- **Department chiefs / hierarchy.** Delegate tasks down the role hierarchy
  (chief → subordinate) within their department; see their region's data.
- **Administrators.** Manage users, roles, regions, and system settings.

Authorization is **RBAC** (§5, §10): a global permission catalog `(domain, action)`,
roles that bundle permissions, and user-role assignments. Organizational reach is
governed by **region scope**: regional users see their own region; head-office
users with the `region:all` permission see every region.

---

## 4. Deployment & Tenancy Model

- **Single organization (single tenant).** No tenant dimension in data or code.
- **Regional segmentation, not tenancy.** `regions` is a logical visibility and
  organizational dimension *within* the one organization, seeded with the
  administrative regions of Tajikistan (e.g. Dushanbe, Sughd, Khatlon, GBAO, DRS)
  and admin-editable. It is **not** a physical disaster-recovery or replication
  boundary.
- **Single-site deployment.** Docker Compose on one КЧС-controlled server.
  Backups are co-located and off-server per the backup policy. No Kubernetes, no
  managed cloud, no cross-datacenter replication.
- **On-prem / data sovereignty.** All data and processing stay on the КЧС server.

---

## 5. In-Scope Modules

Grouped by layer. Each is a NestJS module owning its own data; cross-module
references go through public APIs or in-process events, never shared tables.

**Foundation**
- **Auth** — login, refresh, session lifecycle (no tenant claims).
- **MFA** — TOTP-based two-factor; **Password reset**.
- **RBAC** — global permission catalog, roles, role-permissions, user-roles.
- **Regions** — regional segmentation and region-scope resolution (`region:all`).
- **Users** — user lifecycle, organizational hierarchy, preferences.
- **Audit** — append-only audit log with **hash-chain** integrity and file export.
- **Request context, database access, Redis, storage (MinIO), config** — plumbing
  (with the tenant layer removed).

**Operational domain**
- **Incidents** — emergency incidents with a validated state machine, severity,
  assignment, region scope.
- **Cases** — case management (investigation/handling) with activity log and
  transitions.
- **Tasks / board** *(to build)* — Jira/Trello-style tasks and delegation along
  the role hierarchy. (Not present in the current code; see plan.md.)
- **Notifications** — in-app notifications and user preferences.

**Documents (EDMS / СЭД)**
- **Documents** — document lifecycle, **versioning**, **retention & legal hold**,
  metadata. System of record in PostgreSQL; content in MinIO.
- **Folders** — hierarchical folder tree (ltree) with permission inheritance.
- **Imports** — CSV/Excel and structured data import workers (analyst-facing).

**Spatial**
- **GIS** — vector/raster layers and features over **PostGIS**; spatial queries.
- **Vector tile server** — serves vector tiles to the web map.
- **GeoServer / OGC interop** — WMS/WFS/WMTS so **QGIS and ArcGIS** connect
  directly to authoritative layers.
- **Web map** — MapLibre GL frontend.

**Discovery**
- **Search** — PostgreSQL full-text search across platform objects.

**Analytics**
- **Analytics & dashboards** — operational dashboards and reports computed from
  **PostgreSQL** (not ClickHouse). Scheduled report export (PDF/XLSX) via queue.

**Communication**
- **Chat (MVP)** — channels and direct messages with platform context; real-time
  via the WebSocket gateway.
- **Realtime gateway** — authenticated WebSocket for presence, notifications,
  live updates.

**Operations**
- **Health, metrics, backups** — health probes, Prometheus metrics, scheduled
  PostgreSQL backups + restore tooling.
- **OpenAPI + API versioning** — generated API contract.

> *Video/audio calls* are intentionally **not** a module here — see §2 and §12
> (integrate self-hosted Jitsi later).

---

## 6. Architecture

- **Modular monolith** in NestJS. Explicit module boundaries; a module owns its
  tables; cross-module access via public service APIs or **in-process events**
  (Nest `EventEmitter`). The outbox pattern remains available but is off by
  default; a network broker is introduced only on actual service extraction.
- **PostgreSQL is the single source of truth** for all transactional, spatial
  (PostGIS), and document-metadata data. Redis for cache/queues. MinIO for blobs.
- **Idempotent command handlers and event consumers.** State-mutating actions
  append to the audit log.
- **Separate processes only where unavoidable, later:** Jitsi (video) and a
  Python/FastAPI service (ML forecasting) — both out of v2.0 scope.

---

## 7. Technology Stack

(As established in ADR-0001; deferred items from §2 removed.)

| Layer | Choice |
|---|---|
| Frontend / BFF | Next.js 15 (App Router, RSC, Server Actions) |
| Backend | NestJS (modular monolith) |
| Language | TypeScript (strict) end to end |
| ORM | Drizzle ORM |
| OLTP + spatial + vector DB | PostgreSQL 16 + PostGIS 3.4 + pgvector |
| Cache / queues | Redis 7 |
| Object storage | MinIO (single-node, S3-compatible) |
| GIS interop | GeoServer + vector tiles; MapLibre GL on the web |
| Realtime | WebSocket gateway (Redis pub/sub for fan-out) |
| Events | In-process (Nest EventEmitter); outbox optional |
| Reverse proxy / TLS | Caddy |
| Containers | Docker Compose (no Kubernetes) |
| Observability | Structured logs + Prometheus + health probes |

---

## 8. Data, Spatial & Integrations

- **GIS interop is a hard requirement.** PostGIS holds authoritative spatial
  state. OGC services (GeoServer; vector/feature tiles) expose layers so QGIS and
  ArcGIS connect directly. The web map consumes **vector tiles**, never raw
  geometry, to stay responsive.
- **Import/export for analysts.** CSV/Excel import with validation and row-level
  error reporting; report export to PDF/XLSX through background jobs.
- **Search.** PostgreSQL FTS with appropriate indexes across documents,
  incidents, cases, and other objects.

---

## 9. Non-Functional Requirements (scoped to one server)

- **Availability.** The platform must stay up during an emergency — that is the
  whole point of an emergency-management system. Target high availability *within
  the single-site constraint*: process supervision, fast restart, no single
  in-process bottleneck. (Not multi-region; that is §2.)
- **Backups & recovery.** Scheduled PostgreSQL backups with tested restore.
  Realistic single-server targets: RPO ≤ 24h on a daily-backup baseline (tighter
  with WAL archiving), RTO measured and documented in the DR runbook.
- **Performance ("must not lag").** Performance is query discipline, not language
  choice: server-side pagination/filtering for large grids, virtualized tables on
  the web, PostGIS GIST indexes + vector tiles for the map, background queues for
  report generation and imports, disciplined eager-loading to avoid N+1.
- **Auditability.** Every state-mutating action is attributable to identity, time,
  and (where relevant) region, via the hash-chained audit log; exportable to file.
- **Security.** RBAC + region scope on every read/write path; 2FA (TOTP); secrets
  managed outside source; on-prem only.
- **Localization.** UI in Russian and Tajik (English optional); strings
  externalized from the start.

---

## 10. Security & Audit

- **RBAC** — global permission catalog, per-role permission sets, user-role
  assignment; permissions checked at the API boundary.
- **Region scope** — reads/writes confined to the actor's region unless the actor
  holds `region:all`; new rows are stamped with the actor's region.
- **Audit** — append-only, hash-chained, tamper-evident; file export for archival.
- **Authentication** — session + refresh; TOTP MFA; rate-limited auth endpoints.
- **Sovereignty** — fully on-prem; no external runtime calls.

---

## 11. Roadmap

The phased build order, dependencies, and done-criteria live in
[`plan.md`](./plan.md). Phase 0 is the scope reduction described here; subsequent
phases build the in-scope modules in dependency order.

---

## 12. Deferred Features Register

Removed now; each returns only when its trigger is met (and via an ADR).

| Feature | Returns when |
|---|---|
| ClickHouse analytics sink | Postgres aggregation latency on real data is a measured bottleneck |
| OpenSearch / federated search | Postgres FTS is measurably insufficient at real data volume |
| NATS/Kafka broker | A module is actually extracted into a separate service |
| Temporal | Workflow complexity genuinely exceeds in-app state machines + scheduled jobs |
| AI: vector / semantic search / RAG / copilot / forecasting | Core platform is in production with real data flowing, and there is a concrete analyst use case to train/serve |
| Video / audio calls (Jitsi + Jibri) | Real-time AV becomes an operational requirement |
| Real-time collaborative editing | Multi-user simultaneous editing becomes a real need |
| Mobile companion (PWA / native) | Field data collection on mobile is prioritized |
| Wiki / API keys / visual workflow builder | A concrete need is identified and prioritized |

---

## Document Maintenance

This document is the **single source of truth** for build scope. Where the live
repository (modules, ADRs, infra) conflicts with this document, **this document
wins**, and the conflict is resolved by an ADR. v2.0 supersedes v1.0; ADRs for
removed capabilities are marked Superseded. New architectural decisions are
recorded as ADRs referenced from here.
