# ROADMAP
## Phased delivery against the ToR, anchored to the current state of the codebase

**Anchor commit:** `45d100e` (tag `0.0.1`) on 2026-05-24.
**Premise:** the codebase today is **~25 % of Phase 1** in ToR §17, with a Tajikistan-Crisis-Management UI vertical embedded in the otherwise generic platform shell.

This roadmap presents **five scale horizons** layered on top of the ToR's five phases. Each phase has explicit entry criteria (what must be true to start the phase), exit criteria (what "done" looks like), critical paths, and explicit non-goals (so phase creep is visible).

The roadmap is **realistic for the actual team size in ADR-0001** (one engineer + AI assistant), with deltas where a real ToR-§19 team (50–70 engineers) would compress timelines.

---

## Horizon overview

| Horizon | Phase | Target user volume | Target tenant count | Status today |
|---|---|---|---|---|
| H0 — Pre-MVP | Phase 1 ⊂ ToR §17.1 | 1 internal team | 1 | **In progress** |
| H1 — MVP | Phase 1 complete | 10² users | 1–2 | **Starts after H0 closes** |
| H2 — Beta | Phase 2 + parts of §17.3 | 10³ users | 2–5 | |
| H3 — Production | Phase 2 + 3 + selected §17.4 | 10⁴ users | 5–25 | |
| H4 — Enterprise scale | Phase 3 + 4 | 10⁴+ users | 25–100 | |
| H5 — National scale | Phase 5 + Horizon-2/3 evolution | 10⁵ users | many / federated | |

---

## Horizon 0 — Pre-MVP (where we are)

**Reality check:** the platform is functional for a single team of staff users uploading and listing tenant-scoped documents, with a coherent (but mostly-demo) dashboard. It is **not** ready for any user who is not the developer.

**Exit criteria to leave H0:**
- ✅ Tenant isolation enforced at DB layer **and** regression-tested.
- ✅ Auth: refresh rotation + replay detection + audit on every outcome.
- ✅ Documents: upload → finalize → list → download → soft-delete.
- ✅ CI: format + lint + typecheck + build + e2e (API + browser) + migrations.
- ❌ Rate limiting on auth endpoints.
- ❌ At least one form of MFA.
- ❌ Basic observability (structured JSON logs, request-id, `/metrics` endpoint).
- ❌ Backups for Postgres + MinIO.
- ❌ A reverse proxy / TLS strategy committed.

**Estimated time-to-leave-H0:** ~3–4 weeks of solo-dev focus on the missing items.

---

## Horizon 1 — MVP

### Theme
**"One ministry, internal users, one tenant, documents + incidents."**

### Entry criteria
- All H0 exits met.
- The dashboard's hardcoded copy refactored into a `tenant_branding` table so the platform is generic again while the Tajikistan deployment is data-driven.

### Scope additions

| Module | What lands |
|---|---|
| **IAM** | MFA (TOTP), rate limiting (auth + global), password reset flow, admin-set passwords with first-login forced rotation. |
| **RBAC** | Tables (`roles`, `permissions`, `role_permissions`, `user_roles`); `@Authorize('document:read')` guard; system roles (`tenant_admin`, `auditor`, `operator`). One starter set of permissions per existing module. |
| **Admin Panel** | Server-component admin pages for `Users`, `Roles`, `Tenants` (list / create / disable). Step-up auth for destructive actions. |
| **Incidents** (NEW MODULE) | Schema (`incidents` with severity, status, region, type, source, occurred_at, reported_by); CRUD endpoints; audit on every transition; admin UI for triage. Lifts the dashboard's "Priority Incidents" panel onto real data. |
| **Notifications** (in-platform + email) | `notifications` table, NestJS dispatcher, MJML templates, per-user preferences (minimal). |
| **Observability foundation** | Pino structured logs, `request_id` injection, OTEL HTTP/Postgres/S3 auto-instrumentation, Prometheus `/metrics`, single-instance Tempo + Loki + Grafana in compose. |
| **Backups** | Nightly `pg_dump` cron + MinIO mirror to a second bucket; tested restore procedure. |
| **Deployment** | Caddy reverse proxy in compose, Let's Encrypt, env-var-driven hostnames. App `Dockerfile`s for `api` and `web`. |

### Non-goals (explicit)
- GIS, Workflow, Chat, Video, Wiki, Search Engine (federated), Realtime Collaboration, AI, Analytics dashboard builder.
- Multi-tenant onboarding (still one tenant).
- HA (single instance).
- ABAC / OPA.

### Critical path
```
Rate-limit + MFA (auth-hardening)
        → RBAC tables + guards
                → Admin Panel (uses RBAC)
                → Incidents module (uses RBAC)
                        → Notifications (consumes incident events ... but no event bus yet → direct service call until H2)
        → Observability stack (parallel)
        → Backups (parallel)
        → Deployment hardening (parallel)
```

### Solo-dev timeline: ~10–14 weeks.
### Real ToR-§19 team timeline: 4–6 weeks (a Phase-1 backend cell of 5 engineers).

### Exit criteria
- A second person (not the developer) can log in, see incidents, file an incident, attach a document, and the audit log captures every step.
- Restore from backup demonstrated.
- Grafana shows P95 latency for `/v1/auth/login`, `/v1/incidents`, `/v1/documents`.
- Three or fewer of the §6.x security controls remain unaddressed.

---

## Horizon 2 — Beta

### Theme
**"Multi-tenant, multi-user, event-driven, with the first real-time surface and the first GIS surface."**

### Entry criteria
- All H1 exits met.
- ABAC requirement re-evaluated: at least the `document.classification` ABAC policy stub modelled.
- 2 additional tenants standing up on staging.

### Scope additions

| Theme | What lands |
|---|---|
| **Event plane** | NATS JetStream (compose). Outbox table. Relay worker. Standard envelope (`event_id`, `trace_id`, `causation_id`, `correlation_id`, `tenant_id`). First two consumers: audit-projection-to-ClickHouse and websocket-fan-out. |
| **Analytics plane** | ClickHouse single-shard in compose. Audit-event archive consumer. First materialised views for incident analytics (MTTR, SEV-distribution, by-region). |
| **Realtime plane** | WebSocket gateway (separate NestJS service). JWT auth on upgrade. Subject pattern `tenant:X:domain:Y:resource:Z`. Heartbeat + reconnect + last-event-id replay. Redis pub/sub for cross-instance fanout (still single instance — pattern is there). |
| **GIS substrate** | `gis_layers`, `gis_features` schemas with `geometry(GeometryZ, 4326)`. PostGIS GIST indexes. Layer-CRUD endpoints. Feature-CRUD endpoints. `gis_features` under RLS. Layer-level RBAC (`gis:layer:edit`). |
| **GIS frontend** | MapLibre GL setup in `apps/web`. Layer toggle UI. Feature read-only render. Custom tile server (NestJS service hitting `ST_AsMVT`) with tenant filtering. |
| **Cases** (NEW MODULE) | Case types per tenant, assignment, SLA timers (deadlines via cron job until Temporal lands), status timeline, linked artifacts (incidents, documents, geo features). |
| **Dashboard data** | Replace dashboard demo arrays with ClickHouse-backed queries through a `MetricsService`. The widget set stays static; the data is real. |
| **Search (foundation)** | Postgres `tsvector` GIN on `documents.name + description` + `incidents.summary + description`. ILIKE replaced. Cross-domain `/v1/search` endpoint that fans out to per-domain Postgres FTS queries. |
| **Notifications evolution** | Subscribe to NATS topics; expand templates; web-push (W3C, self-hosted VAPID). |
| **Admin Panel evolution** | Role/permission editor, tenant branding editor, feature flags table, audit explorer. |
| **Storage evolution** | Multipart upload (>100 MB), tus.io resumable; preview generation worker for images + PDFs via BullMQ. |
| **Observability evolution** | Per-tenant dashboards in Grafana; alerting rules with runbook links; SLO definitions for tier-1 endpoints (auth, audit, incident-create). |
| **Secrets** | Vault dev mode in compose; first workload (DB credentials for `cmc_app`) sourced from Vault. |

### Non-goals (explicit)
- Video conferencing (Phase 4).
- Realtime collaboration / CRDT (Phase 4).
- Workflow engine (Temporal) — Phase 3.
- AI / RAG — Phase 5.
- HA (still single instance).

### Critical path
```
NATS + outbox + relay
        → audit-projection-to-CH (parallel)
        → WS gateway + fan-out      → realtime incident feed on dashboard
GIS substrate
        → GIS frontend
        → cross-link incidents ↔ features
Cases
        → dashboards reflect cases
Search foundation (parallel)
ABAC policy modelling (parallel — informs Cases assignment)
```

### Solo-dev timeline: ~5–7 months.
### Real ToR-§19 team timeline: 6 months (matches ToR §17.2 estimate).

### Exit criteria
- 3 active tenants. 50+ active users.
- 5+ events flowing through NATS daily; 2+ consumers; DLQ pattern operational.
- Map shows real geo-features for one tenant.
- Dashboard renders from real data, not demo arrays.
- One `gis:layer:edit` permission denial recorded in audit log (= ABAC works).

---

## Horizon 3 — Production

### Theme
**"Workflows, formal ECM, federated search, ready for one ministry to retire its prior tooling."**

### Entry criteria
- All H2 exits met.
- A pilot tenant has committed to retiring one upstream system (e.g., its prior incident tracker) and migrating to the platform.
- Performance budgets met under projected pilot load (k6 test results green).

### Scope additions

| Theme | What lands |
|---|---|
| **Workflow engine** | Temporal self-hosted. First workflow: incident-response runbook (declared severity → assemble responders → page on-call → create war-room channel-or-thread → SLA timers → post-mortem template). |
| **ECM evolution** | Folder model (`ltree`), permission inheritance, file versioning (`document_versions`), retention policies + legal hold + classification metadata schema. |
| **OpenSearch** | Permission-aware indexing. Federated search query at `/v1/search` fans out to OpenSearch + ClickHouse-aggregated metadata. Saved searches + search alerts. |
| **Visual workflow builder (MVP)** | React Flow-based node-graph; trigger / condition / action / approval nodes; compiles to Temporal workflows on publish. |
| **External API surface** | API-key issuance per tenant; `/v1` external paths exposed through Caddy + per-tenant rate quota; webhooks with signed payloads + DLQ + replay UI. |
| **Wiki / KB (MVP)** | Spaces, pages, block editor (TipTap), Markdown export/import, version history. **No real-time collaboration yet — Phase 4.** |
| **Data import/export** | BullMQ-orchestrated CSV / Excel / GeoJSON / Shapefile import with validation + quarantine queue. CSV export from any list endpoint. |
| **Chat & Messaging (MVP)** | 1:1 DM + group channels; messages persisted to Postgres + projected to ClickHouse for analytics; realtime via WS gateway; per-channel-month index in OpenSearch. **No E2EE yet.** |
| **Observability evolution** | Service-level objectives with error budgets. Synthetic monitoring (5-min login probe). Per-tenant SLO compliance dashboard. |
| **Compliance evidence** | SOC 2 control mapping document; audit-log hash chain operational; Merkle root anchored daily to an external store (S3 with Object Lock as a starter). |
| **HA introduction** | Two API instances behind Caddy with sticky sessions; Postgres primary + 1 streaming replica; PgBouncer in transaction-pooling mode; Redis Sentinel. |

### Non-goals
- Video conferencing.
- AI/RAG.
- Multi-region.

### Critical path
```
Temporal + first workflow (Incident-Response)
        → Visual builder MVP
ECM (folders + versions + retention + legal hold)
        → search (OpenSearch) ← also feeds Wiki
Wiki MVP
Chat MVP
        ↳ all consumers of NATS / WS
External API + webhooks
HA introduction (parallel — devops thread)
```

### Solo-dev timeline: ~9–12 months.
### Real ToR-§19 team timeline: 6 months (matches ToR §17.3 estimate).

### Exit criteria
- Pilot tenant in production with daily workflow execution and 100+ daily users.
- 99.95 % availability over a rolling 30-day window.
- A successful "kill the leader Postgres" chaos test.
- External API consumed by at least one partner system.

---

## Horizon 4 — Enterprise scale

### Theme
**"Real-time collaboration, video, mobile companion, federated tenants, the platform users live in."**

### Entry criteria
- All H3 exits met.
- 5+ tenants in production.
- Hiring done — a real Realtime/Comms team (per ToR §19.9).

### Scope additions

| Theme | What lands |
|---|---|
| **Realtime collaboration (CRDT / Yjs)** | Across documents (Wiki pages, dashboard editing, workflow diagrams). Presence cursors, anchored comments, offline reconcile. |
| **Video conferencing (LiveKit)** | SFU, coturn, recording via egress, calendar integration (CalDAV/Nextcloud), polls/hand-raise/captions (via self-hosted Whisper). |
| **Operational Monitoring Center** | Multi-monitor wall view, alert ticker, KPI tiles with thresholds, time-replay. The "Command Center" sidebar entry becomes real. |
| **Mobile companion** | React Native app: incident filing, approval inbox, map view, push notifications via self-hosted UnifiedPush. |
| **Media management** | FFmpeg transcoding pipeline, HLS streaming, watermarking, signed-URL access. |
| **Realtime analytics** | Streaming aggregations (ClickHouse Live Views or Flink). Anomaly detection on time-series. |
| **Multi-region (active-passive)** | DR site with logical replication. RPO 5 min, RTO 30 min for tier-1 services. |
| **Vault production mode** | Per-pod dynamic DB credentials. mTLS between services. |
| **Service mesh (selective)** | Linkerd for mTLS + observability on critical paths (auth, audit, billing-of-resources). |

### Non-goals
- AI in production (Phase 5).
- Multi-region active-active.

### Solo-dev timeline: not feasible.
### Real ToR-§19 team timeline: 6 months (matches ToR §17.4 estimate).

### Exit criteria
- 10⁴ users, 25+ tenants.
- Video deployed in production with measured P95 join time < 3 s.
- DR drill passed quarterly.

---

## Horizon 5 — National scale

### Theme
**"AI copilots, federated sovereign deployments, multi-region active-active."**

### Entry criteria
- All H4 exits met.
- Established hiring of an AI/ML team (per ToR §19.11).
- GPU infrastructure in place (per ToR §16.8 — self-hosted vLLM/TGI/Ollama on internal GPUs).

### Scope additions

| Theme | What lands |
|---|---|
| **LLM gateway** | vLLM serving open-weight models (Llama 3.x / Qwen / Mistral) on internal GPU fleet. Provider-agnostic abstraction. Per-tenant rate limits + audit. |
| **Vector pipeline** | Qdrant or graduated pgvector for billion-scale. Embedding workers. |
| **Semantic search** | Hybrid BM25 + vector kNN, reciprocal rank fusion, permission filter. |
| **RAG framework** | Retrieval → context → LLM → response-with-citations → audit. |
| **Per-module copilots** | GIS copilot, Document copilot, Workflow copilot, Incident copilot. |
| **Document intelligence** | Tesseract / PaddleOCR / docTR OCR pipeline. Auto-classification, entity extraction, summarisation. |
| **AI analytics** | Anomaly detection on operational metrics (Prophet / isolation forest). Forecasting. |
| **Multi-region active-active** | Selective replication per domain (identity global / audit regional / tenant pinned). Federated event bus via NATS Leafnodes or Kafka MirrorMaker 2. |
| **Sovereign deployments** | Airgapped installer. Per-region GPU pools. Per-tenant dedicated infrastructure offering. |
| **Edge intelligence** | Local-inference modes for low-connectivity regions. |
| **Federation** | Cross-tenant collaboration when tenants opt in. |

### Real ToR-§19 team timeline: 6+ months (matches ToR §17.5 estimate).

### Exit criteria
- 10⁵ concurrent users supported in a load test.
- At least one sovereign deployment (national agency airgapped).
- AI features in daily use by 30 %+ of active users.

---

## Continuous threads (every horizon)

These threads run **in parallel with the phase work** and never finish:

| Thread | What it means |
|---|---|
| **Security hardening** | Pentest cycles, OWASP top-10 sweeps, dependency CVE response, key rotation drills. |
| **Performance optimisation** | k6 load tests as a release gate. Slow-query reviews. Cache hit-rate monitoring. |
| **Documentation** | ADR for every major decision. Runbooks for every operational task. Module READMEs. |
| **DR drills** | Quarterly fail-over tests. Annual full DR exercise. |
| **Compliance audits** | SOC 2 Type II preparation (target: H3 exit). ISO 27001. GDPR readiness for any non-Tajikistan tenant. |
| **Customer feedback integration** | Direct channel from operators to engineering. Backlog grooming. |
| **Tech-debt sprints** | One sprint in every 4–6 dedicated to debt from the [TECH_DEBT_REGISTER](./TECH_DEBT_REGISTER.md). |

---

## Roadmap risk flags

| Flag | Where it bites | Suggested response |
|---|---|---|
| Solo-dev timelines are 4–6× the team timelines | H1–H3 in particular | Plan first hires around H2 exit; until then prioritise foundation > features |
| Tajikistan vertical pulling the platform in a Crisis-Management-specific direction | Every horizon | Maintain a clean separation between the generic platform (in this repo) and the TJ-specific configuration (in a `tenant_config` table or a sibling repo) |
| The "no paid third-party runtime dependencies" rule + scale ambitions | H3+ — LLM serving and SFU operations are real costs even when self-hosted | Build cost models per horizon; accept that "self-hosted" ≠ "free", it means "predictable cost" |
| Skipping observability past H1 | H2+ debugging gets expensive | Treat the observability stack as a Day-0 substrate in H1, not a deliverable |
| RBAC + ABAC postponed to H2 | Within-tenant access control absent | The H1 RBAC requirement is non-negotiable — without it, the Documents module is a "every authenticated user can read every document" surface |

---

## How to use this roadmap

- **Each Horizon is a release brand**, not a calendar window. "H1 done" is a fact, not a date.
- The Solo-dev vs Real-team timelines exist so management can decide *which one* they want.
- **Cross-reference [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md)** for the day-1 backlog inside each horizon.
- **Cross-reference [TECH_DEBT_REGISTER.md](./TECH_DEBT_REGISTER.md)** to see which debt items are blocking which horizon.
