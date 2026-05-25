# MODULE STATUS MATRIX

Compact one-row-per-module view. Detail per module is in
[`IMPLEMENTATION_TRACKER.md`](./IMPLEMENTATION_TRACKER.md).

**Status legend:** 🟢 DONE · 🟡 PARTIAL · 🟠 STUB · 🔴 NOT STARTED · ⛔ BLOCKED · ♻ NEEDS REFACTOR

**Score axes (0–10):** Arch — architectural compliance with ToR §2.3; Prod — production readiness; Scale — Horizon-1 (10³ users) scale readiness; Sec — security posture for the scope claimed.

---

## ToR §3 — Core platform modules

| # | Module | Status | Compl. % | Arch | Prod | Scale | Sec | Code location |
|---|---|---|---|---|---|---|---|---|
| 3.1 | Identity & Access Management | 🟡 | 40 | 8 | 8 | 7 | 7 | `apps/api/src/modules/auth/`, `apps/web/src/auth.ts` — P0.1 rate-limit + P0.4 session cache added |
| 3.2 | Multi-Tenancy (shared-schema RLS) | 🟢 | 50 | 9 | 8 | 6 | 9 | `0002_rls_policies.sql`, `tenant-database.service.ts`, `tenant-transaction.interceptor.ts` |
| 3.3 | RBAC / ABAC Authorization | 🔴 | 0 | — | — | — | — | (none) |
| 3.4 | GIS & Geospatial Intelligence | 🔴 | 2 | — | — | — | — | PostGIS ext. only |
| 3.5 | Analytics & Reporting | 🔴 | 0 | — | — | — | — | (none — ClickHouse not present) |
| 3.6 | Realtime Event System | 🔴 | 0 | — | — | — | — | (none — NATS not present) |
| 3.7 | Dashboard Builder | 🔴 | 0 | — | — | — | — | `/dashboard` page is static demo |
| 3.8 | File Management System | 🟡 | 20 | 8 | 8 | 6 | 7 | `apps/api/src/modules/storage/` |
| 3.9 | Enterprise Document Mgmt | 🟡 | 10 | 7 | 7 | 5 | 7 | `apps/api/src/modules/documents/` |
| 3.10 | Workflow / BPM Engine | 🔴 | 0 | — | — | — | — | (none — Temporal not present) |
| 3.11 | Chat & Messaging | 🔴 | 0 | — | — | — | — | (none) |
| 3.12 | Video Conferencing | 🔴 | 0 | — | — | — | — | (none — LiveKit not present) |
| 3.13 | Notification System | 🔴 | 0 | — | — | — | — | (none) |
| 3.14 | Search Engine | 🔴 | 3 | — | — | — | — | `ILIKE` substring filter in `documents.list` only |
| 3.15 | Audit & Activity Logging | 🟡 | 45 | 7 | 7 | 6 | 6 | `apps/api/src/modules/audit/`, `audit-log` schema |
| 3.16 | Knowledge Base / Wiki | 🔴 | 0 | — | — | — | — | (none) |
| 3.17 | API / Integration Gateway | 🔴 | 0 | — | — | — | — | Next.js BFF is implicit edge, no Kong/Envoy |
| 3.18 | AI-Ready Architecture | 🔴 | 2 | — | — | — | — | pgvector ext. only |
| 3.19 | Administration Panel | 🔴 | 5 | — | — | — | — | Seed + lookup only; no UI |
| 3.20 | Monitoring & Observability | 🔴 | 15 | — | — | — | — | Pino JSON + request_id correlation landed (P0.3); metrics + traces + alerting still 🔴 |
| 3.21 | Data Import/Export | 🔴 | 0 | — | — | — | — | (none) |
| 3.22 | Realtime Collaboration | 🔴 | 0 | — | — | — | — | (none — Yjs not present) |
| 3.23 | Task & Case Management | 🔴 | 0 | — | — | — | — | Dashboard shows "Cases Open 142" but no table exists |
| 3.24 | Media Management | 🔴 | 0 | — | — | — | — | (none — FFmpeg pipeline absent) |
| 3.25 | Geospatial Analytics | 🔴 | 0 | — | — | — | — | sub-scope of §3.4 |
| 3.26 | Operational Monitoring Center | 🔴 | 0 | — | — | — | — | Hero ribbon copy hardcoded |
| 3.27 | Incident / Event Management | 🔴 | 0 | — | — | — | — | (none) |

---

## ToR §4 — GIS deep dive (sub-modules of §3.4)

| §4.x | Capability | Status |
|---|---|---|
| 4.2 | Map engine (MapLibre / pg_tileserv) | 🔴 |
| 4.3 | Tile rendering / CDN cache | 🔴 |
| 4.4 | Vector tiles (MVT) | 🔴 |
| 4.5 | Spatial queries (PostGIS standard ops) | 🔴 |
| 4.6 | Spatial indexes (GIST/BRIN/H3) | 🔴 |
| 4.7 | Geofencing (R-tree evaluator) | 🔴 |
| 4.8 | Layers model | 🔴 |
| 4.9 | Geo objects (feature model) | 🔴 |
| 4.10 | Map permissions (layer/feature/geographic) | 🔴 |
| 4.11 | Realtime tracking pipeline | 🔴 |
| 4.12 | Route visualisation | 🔴 |
| 4.13 | Spatial analytics (hot-spot, DBSCAN, OD, isochrones) | 🔴 |
| 4.14 | Heatmaps | 🔴 |
| 4.15 | Clustering | 🔴 |
| 4.16 | Coordinate-system handling | 🔴 |
| 4.17 | Performance optimisation (simplification, caching, replicas) | 🔴 |
| 4.18 | Map caching strategy (L1–L4) | 🔴 |

---

## ToR §5 — Data architecture

| §5.x | Capability | Status |
|---|---|---|
| 5.1 | OLTP (Postgres + PostGIS) | 🟢 |
| 5.1 | OLAP (ClickHouse) | 🔴 |
| 5.1 | Cache (Redis) | 🟢 wired via `RedisModule` (P0.2 / ADR-0008); no consumers yet — P0.1 / P0.4 / P1.6 / P2.3 / P2.13 are the upcoming consumers |
| 5.1 | Search (OpenSearch) | 🔴 |
| 5.1 | Object storage (MinIO/S3) | 🟢 |
| 5.1 | Vector DB (pgvector/Qdrant) | 🟡 ext. only |
| 5.1 | Time-series (TimescaleDB/CH) | 🔴 |
| 5.1 | Event log (NATS JetStream / Kafka) | 🔴 |
| 5.2 | Postgres responsibilities (state-of-record) | 🟢 |
| 5.3 | ClickHouse responsibilities | 🔴 |
| 5.4 | Event sourcing selectively | 🔴 |
| 5.5 | Data lake (Parquet on S3) | 🔴 |
| 5.6 | Indexing strategies | 🟡 reasonable indexes today; BRIN/GIN/partial absent |
| 5.7 | Partitioning | 🔴 |
| 5.8 | Archival / retention | 🔴 |
| 5.9 | ETL/ELT pipelines | 🔴 |
| 5.10 | Realtime streams | 🔴 |
| 5.11 | Synchronisation (outbox, saga) | 🔴 |

---

## ToR §6 — Security architecture

| §6.x | Capability | Status |
|---|---|---|
| 6.1 | RBAC | 🔴 |
| 6.2 | ABAC (OPA / Rego) | 🔴 |
| 6.3 | Tenant isolation (logical) | 🟢 |
| 6.3 | Tenant isolation (cryptographic — per-tenant DEK) | 🔴 |
| 6.4 | Row-level security | 🟢 |
| 6.5 | Audit trails | 🟡 |
| 6.6 | Immutable WORM logging | 🟡 (policy-level only; no S3 Object Lock) |
| 6.7 | Encryption at rest | 🟡 (host-level depends on deploy; no app-level field encryption) |
| 6.8 | Encryption in transit (TLS / mTLS) | 🟡 (depends on deploy reverse proxy; no mTLS) |
| 6.9 | Secrets management (Vault) | 🔴 |
| 6.10 | Session management | 🟢 |
| 6.11 | MFA (TOTP / WebAuthn / backup codes) | 🔴 |
| 6.12 | SSO (OIDC / SAML / SCIM) | 🔴 |
| 6.13 | Device & session monitoring | 🟡 (IP + UA captured; no anomaly detection) |
| 6.14 | DLP | 🔴 |
| 6.15 | Compliance readiness (SOC 2 / ISO 27001 / GDPR / HIPAA) | 🔴 |
| 6.16 | Zero trust | 🔴 |

---

## ToR §7 — Realtime architecture

| §7.x | Capability | Status |
|---|---|---|
| 7.1 | WebSocket gateway | 🔴 |
| 7.2 | Realtime synchronisation | 🔴 |
| 7.3 | Presence | 🔴 |
| 7.4 | Event streams to clients | 🔴 |
| 7.5 | Optimistic updates | 🔴 |
| 7.6 | Distributed events | 🔴 |
| 7.7 | Reliable notifications | 🔴 |
| 7.8 | WebSocket scaling | 🔴 |
| 7.9 | Realtime collab (Yjs) | 🔴 |

---

## ToR §8 — Video/Audio

| §8.x | Capability | Status |
|---|---|---|
| 8.1 | WebRTC foundation | 🔴 |
| 8.2 | SFU (LiveKit) | 🔴 |
| 8.3 | TURN/STUN (coturn) | 🔴 |
| 8.4 | Screen sharing | 🔴 |
| 8.5 | Adaptive bitrate / SVC | 🔴 |
| 8.6 | Recording (egress) | 🔴 |
| 8.7 | Moderation | 🔴 |
| 8.8 | Enterprise conferencing (calendar, E2EE, captions) | 🔴 |
| 8.9 | Media-infra scaling | 🔴 |

---

## ToR §9 — File management deep dive

| §9.x | Capability | Status |
|---|---|---|
| 9.1 | Folder model (ltree) | 🔴 |
| 9.2 | Permissions inheritance | 🔴 |
| 9.3 | Versioning | 🔴 |
| 9.4 | Metadata extraction | 🔴 |
| 9.5 | Previews / thumbnails | 🔴 |
| 9.6 | Internal sharing | 🟡 (within a tenant, every authed user sees everything) |
| 9.6 | External sharing (public link) | 🔴 |
| 9.7 | Temporary links | 🟢 (pre-signed S3 URLs) |
| 9.8 | Encrypted storage | 🟡 (SSE depends on deploy) |
| 9.9 | Object storage integration | 🟢 |
| 9.10 | Retention policies | 🔴 |
| 9.11 | Search indexing (Tika / OCR) | 🔴 |

---

## ToR §10 — Workflow / BPM

| §10.x | Capability | Status |
|---|---|---|
| 10.1 | Engine choice (Temporal) | 🔴 |
| 10.2 | Approvals | 🔴 |
| 10.3 | Automations | 🔴 |
| 10.4 | Orchestration | 🔴 |
| 10.5 | State machines | 🔴 |
| 10.6 | Event-driven workflows | 🔴 |
| 10.7 | SLA tracking | 🔴 |
| 10.8 | Escalation | 🔴 |
| 10.9 | Visual builder | 🔴 |

---

## ToR §11 — API architecture

| §11.x | Capability | Status |
|---|---|---|
| 11.1 | REST + RFC 7807 errors | 🟢 |
| 11.1 | URL versioning (/v1/) | 🔴 (no version prefix yet) |
| 11.1 | Cursor pagination | 🔴 (offset only) |
| 11.1 | Idempotency-Key header | 🔴 |
| 11.1 | OpenAPI 3.1 generation | 🔴 |
| 11.2 | GraphQL (BFF) | 🔴 |
| 11.3 | WebSocket APIs | 🔴 |
| 11.4 | Internal gRPC / mTLS | 🔴 |
| 11.5 | External APIs (keys, webhooks) | 🔴 |
| 11.6 | API versioning + sunset headers | 🔴 |
| 11.7 | API gateway | 🔴 |
| 11.8 | Rate limiting | 🟡 auth endpoints only (P0.1 / ADR-0009); non-auth + global → P0.9 |
| 11.9 | API security (input validation, CORS, CSRF) | 🟢 input validation + CORS; CSRF N/A (bearer) |
| 11.10 | SDK strategy | 🔴 (contracts package is a start) |

---

## ToR §12 — Frontend architecture

| §12.x | Capability | Status |
|---|---|---|
| 12.1 | Next.js App Router | 🟢 |
| 12.2 | Design system (shadcn + Tailwind + tokens + Storybook) | 🟡 tokens + Tailwind ✓; shadcn config present but components not adopted; no Storybook |
| 12.3 | State mgmt (TanStack Query + Zustand) | 🔴 not yet needed |
| 12.4 | Modular frontend | 🟡 (auth + dashboard + documents pages exist; route-groups not yet) |
| 12.5 | Workspace UI (sidebar, topbar, right panel, dock) | 🟡 sidebar + topbar; no right panel / dock |
| 12.6 | Command palette | 🔴 |
| 12.7 | Docking panels | 🔴 |
| 12.8 | Data grids (TanStack Table) | 🔴 |
| 12.9 | Enterprise UX (density, keyboard, confirmation) | 🟡 partial |
| 12.10 | Accessibility (WCAG 2.1 AA) | 🔴 unverified |
| 12.11 | Responsive strategy | 🟡 desktop-first; some lg: breakpoints |
| 12.12 | Offline-first | 🔴 |
| 12.13 | Performance budgets | 🔴 |

---

## ToR §13 — DevOps & Infrastructure

| §13.x | Capability | Status |
|---|---|---|
| 13.1 | Docker (multi-stage, distroless, non-root, scanned, SBOM) | 🟡 custom Postgres only; no app Dockerfiles |
| 13.2 | Kubernetes | 🔴 |
| 13.3 | CI/CD | 🟡 CI yes (GHA); no CD yet |
| 13.4 | Environments (dev/staging/prod/dr) | 🟡 dev only |
| 13.5 | IaC (Terraform / Helm) | 🔴 |
| 13.6 | Backups | 🟢 nightly `pg_dump` → MinIO sidecar (P0.5 / ADR-0012); rotation 7d; `pnpm db:restore` rehearsed |
| 13.7 | Disaster recovery | 🟡 same-cluster restore path covered; cross-cluster + off-site + PITR still 🔴 |
| 13.8 | Autoscaling | 🔴 |
| 13.10 | Logging (Loki) | 🔴 |
| 13.11 | Tracing (Tempo/Jaeger + OTEL) | 🔴 |
| 13.12 | Monitoring (Prometheus + Thanos) | 🔴 |
| 13.13 | Blue-green deployment | 🔴 |
| 13.14 | Security scanning (SAST/DAST/dependency/container) | 🟡 Dependabot yes; no Trivy / CodeQL / OWASP ZAP |

---

## ToR §14 — Observability

| §14.x | Capability | Status |
|---|---|---|
| 14.1 | Metrics (Prometheus) | 🔴 |
| 14.2 | Tracing | 🔴 |
| 14.3 | Logs | 🟡 structured JSON + request_id correlation (P0.3 / ADR-0010); aggregation (Loki) deferred to P1.7 |
| 14.4 | Alerting + on-call | 🔴 |
| 14.5 | Audit monitoring (SIEM tail) | 🔴 |
| 14.6 | SIEM integration | 🔴 |
| 14.7 | Operational dashboards | 🔴 |
| 14.8 | Health checks (live/ready/startup/deep/synthetic) | 🟡 liveness only |

---

## ToR §15 — Performance & scalability

| §15.x | Capability | Status |
|---|---|---|
| 15.1 | Horizontal scaling | 🔴 (single instance) |
| 15.2 | Caching (L1/L2/L3) | 🔴 (no app cache; Redis deployed but unused) |
| 15.3 | Distributed systems concerns (CAP / backpressure / circuit-breaker / bulkhead) | 🔴 |
| 15.4 | High-load GIS | 🔴 |
| 15.5 | Analytics scaling | 🔴 |
| 15.6 | WebSocket scaling | 🔴 |
| 15.7 | Search scaling | 🔴 |
| 15.8 | Large-file handling (direct PUT, multipart, range) | 🟡 direct PUT; no multipart, no range |
| 15.9 | Multi-region | 🔴 |
| 15.10 | Capacity planning (load testing, chaos) | 🔴 |

---

## ToR §16 — AI readiness

| §16.x | Capability | Status |
|---|---|---|
| 16.2 | AI copilots | 🔴 |
| 16.3 | Semantic search | 🔴 |
| 16.4 | Vector DB | 🟡 pgvector installed |
| 16.5 | Document intelligence | 🔴 |
| 16.6 | OCR (Tesseract / PaddleOCR / docTR) | 🔴 |
| 16.7 | AI analytics (anomaly / forecasting) | 🔴 |
| 16.8 | LLM gateway (vLLM / llama.cpp / Ollama / TGI) | 🔴 |
| 16.9 | RAG framework | 🔴 |
| 16.10 | Recommendation systems | 🔴 |
| 16.11 | AI safety & governance | 🔴 |

---

## Aggregate

- **Modules at DONE:** 1 (multi-tenancy for the shared-schema mode)
- **Modules at PARTIAL:** 4 (IAM, file mgmt, ECM, audit) + dependencies (Redis deployed, contracts shared, Drizzle indexing)
- **Modules at NOT STARTED:** 22 of 27 §3 modules
- **Aggregate ToR coverage:** ~6 %
- **Foundation quality (where built):** high — average Arch/Prod/Sec scores 7+/10 on shipped modules

Phase-1 minimum (per ToR §17.1) requires:
- IAM **full** (today 30 %) — gap: MFA, SSO, rate-limit, password reset
- Multi-tenancy (today 50 % — covers shared-schema mode; gap: cryptographic, migration tooling)
- RBAC **full** + ABAC **scaffolding** (today 0 %)
- Audit (today 45 %, gap: hash chain + SIEM export)
- API Gateway + BFF (BFF ✓, gateway 🔴)
- Notification (in-platform + email) (🔴)
- Administration Panel (basic) (🔴)
- Frontend shell + design system (🟡 partial)
- Observability (🔴)
- CI/CD, IaC, K8s base (CI ✓, no IaC, no K8s)
- File Management (basic) (🟡)
- Search Engine (foundation — keyword) (🔴)

**Reading:** **the codebase is ~25 % of the way through Phase 1 of the ToR roadmap.**

See [`ROADMAP.md`](./ROADMAP.md) for the recovery path and [`PRIORITY_EXECUTION_PLAN.md`](./PRIORITY_EXECUTION_PLAN.md) for sequencing.
