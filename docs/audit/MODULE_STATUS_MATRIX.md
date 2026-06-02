# MODULE STATUS MATRIX

Compact one-row-per-module view. Detail per module is in
[`IMPLEMENTATION_TRACKER.md`](./IMPLEMENTATION_TRACKER.md).

**Status legend:** 🟢 DONE · 🟡 PARTIAL · 🟠 STUB · 🔴 NOT STARTED · ⛔ BLOCKED · ♻ NEEDS REFACTOR

**Score axes (0–10):** Arch — architectural compliance with ToR §2.3; Prod — production readiness; Scale — Horizon-1 (10³ users) scale readiness; Sec — security posture for the scope claimed.

---

## ToR §3 — Core platform modules

| # | Module | Status | Compl. % | Arch | Prod | Scale | Sec | Code location |
|---|---|---|---|---|---|---|---|---|
| 3.1 | Identity & Access Management | 🟡 | 55 | 8 | 8 | 7 | 8 | `apps/api/src/modules/auth/`, `modules/mfa/`, `modules/password-reset/`, `apps/web/src/auth.ts` — + P1.2 TOTP MFA (encrypted secret, backup codes, two-step login); + P1.3 password reset (hashed single-use token, self/admin flows, pluggable notifier, P1.3 / ADR-0021) |
| 3.2 | Multi-Tenancy (shared-schema RLS) | 🟢 | 58 | 9 | 8 | 6 | 9 | `0002_rls_policies.sql`, `tenant-database.service.ts`; + per-tenant branding extracted to data (P0.11 / ADR-0018); + self-service tenant name + branding editing (P1.4d) |
| 3.3 | RBAC / ABAC Authorization | 🟡 | 55 | 8 | 8 | 7 | 8 | RBAC ✅ (per-tenant roles + global catalog + `@Authorize` guard + Redis perm cache, P1.1 / ADR-0019); + `GET /rbac/me` (P1.4a); + **custom-role CRUD** + permission catalog + `role:manage` (P1.4c); ABAC/OPA still 🔴 |
| 3.4 | GIS & Geospatial Intelligence | 🟡 | 20 | 7 | 7 | 7 | 7 | **Spatial substrate (P2.7 / ADR-0037):** `gis_layers` + `gis_features` (`geometry(Geometry,4326)`, GIST), RLS, layer/feature CRUD + **bbox query** (`&&`/`ST_MakeEnvelope`), GeoJSON in/out, `gis_layer:*`/`gis_feature:write` RBAC. **MVT tile server (P2.8 / ADR-0038):** `/v1/gis/tiles/:layer/:z/:x/:y.mvt` (`ST_AsMVT`). Next: MapLibre UI (P2.9), geofencing/analytics |
| 3.5 | Analytics & Reporting | 🟡 | 24 | 7 | 7 | 7 | 7 | **ClickHouse single-shard** + **two projections** (incident events → daily-by-region MV, P2.5/ADR-0033; audit log → `audit_events` + daily-stats MV cursor ETL, P2.2/ADR-0034) + **query API**: `GET /v1/analytics/dashboard` (tenant-scoped CH incident trend, gap-filled, `incident:read`) feeding the dashboard (P2.6 / ADR-0036). Next: more MVs/widgets (by-region trend, audit activity, MTTR), saved reports |
| 3.6 | Realtime Event System | 🟡 | 48 | 7 | 7 | 7 | 7 | **Event plane (P2.1 / ADR-0031):** NATS JetStream + transactional `outbox` + relay + incidents producer; **two durable consumers** — notifications-from-events (DeliverPolicy.New — P2.4 / ADR-0032) + ClickHouse projection (DeliverPolicy.All — P2.5 / ADR-0033), shared dedup ledger. Live-validated end-to-end + trace-correlated. **WebSocket gateway done (P2.3 / ADR-0035)** — NATS→WS fan-out to tenant-isolated, RBAC-checked subscriptions (full-chain live-smoked). Audit projection done (P2.2 / ADR-0034) |
| 3.7 | Dashboard Builder | 🔴 | 0 | — | — | — | — | `/dashboard` now renders **real** data (snapshot from OLTP P1.5c + CH-backed incident trend P2.6/ADR-0036); still a fixed layout, no user-built/configurable dashboards |
| 3.8 | File Management System | 🟡 | 20 | 8 | 8 | 6 | 7 | `apps/api/src/modules/storage/` |
| 3.9 | Enterprise Document Mgmt | 🟡 | 10 | 7 | 7 | 5 | 7 | `apps/api/src/modules/documents/` |
| 3.10 | Workflow / BPM Engine | 🔴 | 0 | — | — | — | — | (none — Temporal not present) |
| 3.11 | Chat & Messaging | 🔴 | 0 | — | — | — | — | (none) |
| 3.12 | Video Conferencing | 🔴 | 0 | — | — | — | — | (none — LiveKit not present) |
| 3.13 | Notification System | 🟢 | 68 | 8 | 8 | 7 | 8 | **P1.6 (a–c / ADR-0024):** in-app + web center (bell/page) + email (Nodemailer/Mailpit) + per-user prefs; **now event-driven** — dispatched by a durable JetStream consumer of incident events (idempotent, decoupled — P2.4 / ADR-0032), inline fallback when NATS off. Future: Web Push, MJML, dead-letter |
| 3.14 | Search Engine | 🔴 | 3 | — | — | — | — | `ILIKE` substring filter in `documents.list` only |
| 3.15 | Audit & Activity Logging | 🟢 | 85 | 8 | 8 | 7 | 8 | `apps/api/src/modules/audit/`; append-only RLS + **tamper-evident hash chain** + **Merkle anchor under Object Lock (WORM)** (P1.11 / ADR-0029) + **SIEM export** (RFC 5424/CEF, P1.12 / ADR-0030) + **ClickHouse archive/analytics projection** (cursor ETL → `audit_events` + daily-stats MV, P2.2 / ADR-0034). Remaining: `audit:read` perm/auditor role, retention/legal-hold, audit explorer UI |
| 3.16 | Knowledge Base / Wiki | 🔴 | 0 | — | — | — | — | (none) |
| 3.17 | API / Integration Gateway | 🔴 | 0 | — | — | — | — | Next.js BFF is implicit edge, no Kong/Envoy |
| 3.18 | AI-Ready Architecture | 🔴 | 2 | — | — | — | — | pgvector ext. only |
| 3.19 | Administration Panel | 🟢 | 60 | 8 | 8 | 7 | 8 | **P1.4 complete (a–d / ADR-0022):** gated `/admin` (`GET /rbac/me`) + Users CRUD + Roles (catalog + custom-role CRUD) + Tenant settings (name + branding). All endpoints `@Authorize`-gated + audited. Deferred: cross-tenant superadmin, step-up auth |
| 3.20 | Monitoring & Observability | 🟢 | 55 | 8 | 8 | 7 | 7 | **Logs+metrics+traces triangle closed:** pino JSON+request_id (P0.3), OTEL traces (P0.6), Prometheus/RED+Grafana (P0.7), Loki (P1.7), **Tempo + Loki↔Tempo link + Alertmanager 5xx rule** (P1.8 / ADR-0026). Remaining: alert delivery/paging, exemplars, prod object-store |
| 3.21 | Data Import/Export | 🔴 | 0 | — | — | — | — | (none) |
| 3.22 | Realtime Collaboration | 🔴 | 0 | — | — | — | — | (none — Yjs not present) |
| 3.23 | Task & Case Management | 🔴 | 0 | — | — | — | — | Dashboard shows "Cases Open 142" but no table exists |
| 3.24 | Media Management | 🔴 | 0 | — | — | — | — | (none — FFmpeg pipeline absent) |
| 3.25 | Geospatial Analytics | 🔴 | 0 | — | — | — | — | sub-scope of §3.4 |
| 3.26 | Operational Monitoring Center | 🔴 | 0 | — | — | — | — | Hero ribbon copy hardcoded |
| 3.27 | Incident / Event Management | 🟢 | 55 | 8 | 8 | 7 | 8 | **P1.5 complete (a–c / ADR-0023):** backend domain (state-machine, 6 perms, stats, soft-delete, audited) + operator UI `/incidents` (list/detail/transition/assign) + **dashboard on real data**. Future: SLA/escalation, timeline, command roles, geometry (GIS) |

---

## ToR §4 — GIS deep dive (sub-modules of §3.4)

| §4.x | Capability | Status |
|---|---|---|
| 4.2 | Map engine (MapLibre / pg_tileserv) | 🟡 in-DB MVT tile server (`ST_AsMVT`, P2.8 / ADR-0038); MapLibre frontend = P2.9 |
| 4.3 | Tile rendering / CDN cache | 🟡 tiles rendered on demand + `Cache-Control` (P2.8); shared cache / CDN pending |
| 4.4 | Vector tiles (MVT) | 🟢 `GET /v1/gis/tiles/:layer/:z/:x/:y.mvt` — `ST_AsMVT` over GIST-filtered tenant features, 204 empty, RLS-scoped (P2.8 / ADR-0038) |
| 4.5 | Spatial queries (PostGIS standard ops) | 🟡 bbox overlap (`&&` / `ST_MakeEnvelope`) + GeoJSON I/O live (P2.7 / ADR-0037); richer ops (distance, within, clustering) pending |
| 4.6 | Spatial indexes (GIST/BRIN/H3) | 🟡 GIST on `gis_features.geometry` (P2.7); BRIN/H3 pending |
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
| 5.1 | OLAP (ClickHouse) | 🟡 single-shard CH + incident projection + daily-by-region MV (P2.5 / ADR-0033); sharding/replication + CH migration tooling → H-tier |
| 5.1 | Cache (Redis) | 🟢 wired via `RedisModule` (P0.2 / ADR-0008); no consumers yet — P0.1 / P0.4 / P1.6 / P2.3 / P2.13 are the upcoming consumers |
| 5.1 | Search (OpenSearch) | 🔴 |
| 5.1 | Object storage (MinIO/S3) | 🟢 |
| 5.1 | Vector DB (pgvector/Qdrant) | 🟡 ext. only |
| 5.1 | Time-series (TimescaleDB/CH) | 🔴 |
| 5.1 | Event log (NATS JetStream / Kafka) | 🟡 NATS JetStream + transactional outbox + relay + **first producer (incidents)** (P2.1 / ADR-0031); durable JetStream consumers → P2.2/P2.4 |
| 5.2 | Postgres responsibilities (state-of-record) | 🟢 |
| 5.3 | ClickHouse responsibilities | 🟡 `incident_events` + daily-by-region MV (P2.5 / ADR-0033) + `audit_events` archive + daily-stats MV (P2.2 / ADR-0034); more rollups + retention/TTL → later |
| 5.4 | Event sourcing selectively | 🔴 |
| 5.5 | Data lake (Parquet on S3) | 🔴 |
| 5.6 | Indexing strategies | 🟡 reasonable indexes today; BRIN/GIN/partial absent |
| 5.7 | Partitioning | 🔴 |
| 5.8 | Archival / retention | 🔴 |
| 5.9 | ETL/ELT pipelines | 🔴 |
| 5.10 | Realtime streams | 🔴 |
| 5.11 | Synchronisation (outbox, saga) | 🟡 transactional outbox landed (P2.1a / ADR-0031); relay + saga/causation orchestration → P2.1b+ |

---

## ToR §6 — Security architecture

| §6.x | Capability | Status |
|---|---|---|
| 6.1 | RBAC | 🟢 per-tenant roles + global permission catalog + `@Authorize` guard + Redis-cached permission sets; documents protected (P1.1 / ADR-0019) |
| 6.2 | ABAC (OPA / Rego) | 🔴 |
| 6.3 | Tenant isolation (logical) | 🟢 |
| 6.3 | Tenant isolation (cryptographic — per-tenant DEK) | 🔴 |
| 6.4 | Row-level security | 🟢 |
| 6.5 | Audit trails | 🟡 |
| 6.6 | Immutable WORM logging | 🟡 (policy-level only; no S3 Object Lock) |
| 6.7 | Encryption at rest | 🟡 (host-level depends on deploy; no app-level field encryption) |
| 6.8 | Encryption in transit (TLS / mTLS) | 🟡 edge TLS via Caddy + automatic Let's Encrypt (P0.9 / ADR-0016); mTLS service-to-service still 🔴 (P4) |
| 6.9 | Secrets management (Vault) | 🔴 |
| 6.10 | Session management | 🟢 |
| 6.11 | MFA (TOTP / WebAuthn / backup codes) | 🟡 TOTP + one-time backup codes (secret AES-GCM at rest, two-step login) (P1.2 / ADR-0020); WebAuthn + per-tenant enforcement pending |
| 6.12 | SSO (OIDC / SAML / SCIM) | 🔴 |
| 6.13 | Device & session monitoring | 🟡 (IP + UA captured; no anomaly detection) |
| 6.14 | DLP | 🔴 |
| 6.15 | Compliance readiness (SOC 2 / ISO 27001 / GDPR / HIPAA) | 🔴 |
| 6.16 | Zero trust | 🔴 |

---

## ToR §7 — Realtime architecture

| §7.x | Capability | Status |
|---|---|---|
| 7.1 | WebSocket gateway | 🟢 | **P2.3 / ADR-0035**: `ws` gateway in apps/api on the HTTP upgrade event, auth-before-handshake (JWT + session), tenant-isolated + fail-closed RBAC subscriptions, ephemeral NATS fan-out (`DeliverPolicy.New`) → `broadcast()`, status endpoint. Full-chain live-smoked. Single-instance (Redis fan-out = scale follow-on) |
| 7.2 | Realtime synchronisation | 🔴 |
| 7.3 | Presence | 🔴 |
| 7.4 | Event streams to clients | 🟡 | Events fan out to subscribed sockets end-to-end (P2.3 / ADR-0035); browser client hook/UI is the follow-on (with P2.6) |
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
| 11.1 | URL versioning (/v1/) | 🟢 global `/v1` prefix on all domain routes (P1.9 / ADR-0027); `/health*` + `/metrics` excluded |
| 11.1 | Cursor pagination | 🔴 (offset only) |
| 11.1 | Idempotency-Key header | 🔴 |
| 11.1 | OpenAPI 3.1 generation | 🟢 full doc (P1.10 / ADR-0028): request DTOs (CLI plugin) + **Zod-contract response schemas** (zod-to-json-schema, 82 components), tags + global bearer + public overrides post-processed (zero controller decorators), served at gated `/v1/openapi.json` (`tenant:manage` + `OPENAPI_ENABLED`) + **Swagger UI** at web `/admin/api-docs`. Emits valid 3.0.0 (3.1 bump = TD; self-host UI assets = TD) |
| 11.2 | GraphQL (BFF) | 🔴 |
| 11.3 | WebSocket APIs | 🟡 `/v1/realtime` gateway live (P2.3 / ADR-0035): typed JSON protocol in `@cmc/contracts/realtime`, auth + tenant + RBAC scoped subscriptions. Not in the OpenAPI doc (WS ≠ REST); browser client = follow-on |
| 11.7 | Binary / tile endpoints | 🟡 MVT vector tiles `/v1/gis/tiles/*.mvt` (`ST_AsMVT`, binary, P2.8 / ADR-0038) |
| 11.4 | Internal gRPC / mTLS | 🔴 |
| 11.5 | External APIs (keys, webhooks) | 🔴 |
| 11.6 | API versioning + sunset headers | 🟡 `/v1` versioning live (P1.9 / ADR-0027); sunset/deprecation headers deferred — nothing to deprecate yet |
| 11.7 | API gateway | 🟡 Caddy edge (TLS, security headers, ops-endpoint block, host routing) (P0.9 / ADR-0016); full Kong/Envoy + WAF + quota still 🔴 |
| 11.8 | Rate limiting | 🟡 auth endpoints only (P0.1 / ADR-0009); non-auth + global → P0.9 |
| 11.9 | API security (input validation, CORS, CSRF) | 🟢 input validation + CORS; CSRF N/A (bearer) |
| 11.10 | SDK strategy | 🔴 (contracts package is a start) |

---

## ToR §12 — Frontend architecture

| §12.x | Capability | Status |
|---|---|---|
| 12.1 | Next.js App Router | 🟢 |
| 12.2 | Design system (shadcn + Tailwind + tokens + Storybook) | 🟡 tokens + Tailwind ✓; per-tenant branding copy extracted to data (P0.11 / ADR-0018, `theme` jsonb reserved); shadcn components + per-tenant theming + Storybook still pending (TD-023) |
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
| 13.1 | Docker (multi-stage, distroless, non-root, scanned, SBOM) | 🟡 api + web multi-stage distroless non-root images (P0.10 / ADR-0017) + custom Postgres; scanning + SBOM still 🔴 (TD-029) |
| 13.2 | Kubernetes | 🔴 |
| 13.3 | CI/CD | 🟡 CI yes (GHA); no CD yet |
| 13.4 | Environments (dev/staging/prod/dr) | 🟡 dev + a deploy overlay (Caddy edge, `infra/deploy-compose.yml`, `.env.production`) for external serving (P0.9 / ADR-0016); staging/DR envs still pending |
| 13.5 | IaC (Terraform / Helm) | 🔴 |
| 13.6 | Backups | 🟢 nightly `pg_dump` → MinIO sidecar (P0.5 / ADR-0012); rotation 7d; `pnpm db:restore` rehearsed |
| 13.7 | Disaster recovery | 🟡 same-cluster restore path covered; cross-cluster + off-site + PITR still 🔴 |
| 13.8 | Autoscaling | 🔴 |
| 13.10 | Logging (Loki) | 🔴 |
| 13.11 | Tracing (Tempo/Jaeger + OTEL) | 🟡 OTEL SDK emits HTTP+DB+S3+Redis spans (P0.6 / ADR-0013); Tempo collector deferred to P1.8 |
| 13.12 | Monitoring (Prometheus + Thanos) | 🟡 Prometheus scraping `/metrics` + Grafana in compose (P0.7 / ADR-0014); Thanos/long-term storage pending |
| 13.13 | Blue-green deployment | 🔴 |
| 13.14 | Security scanning (SAST/DAST/dependency/container) | 🟡 Dependabot yes; no Trivy / CodeQL / OWASP ZAP |

---

## ToR §14 — Observability

| §14.x | Capability | Status |
|---|---|---|
| 14.1 | Metrics (Prometheus) | 🟡 `/metrics` (prom-client): RED histogram + DB saturation + Node defaults; Prometheus+Grafana compose + checked-in dashboard (P0.7 / ADR-0014); business metrics + alerting still pending |
| 14.2 | Tracing | 🟡 OTEL spans emitted (HTTP/DB/S3/Redis), trace_id on logs + audit, W3C propagation (P0.6 / ADR-0013); collector (Tempo) → P1.8 |
| 14.3 | Logs | 🟡 structured JSON + request_id **and trace_id** correlation (P0.3 / P0.6); aggregation (Loki) deferred to P1.7 |
| 14.4 | Alerting + on-call | 🔴 |
| 14.5 | Audit monitoring (SIEM tail) | 🔴 |
| 14.6 | SIEM integration | 🟡 export side: audit log ships as RFC 5424 syslog / CEF to a file/TCP sink (P1.12 / ADR-0030); a running SIEM (Wazuh/OpenSearch) + a managed forwarder (Vector/Fluent Bit) still 🔴 |
| 14.7 | Operational dashboards | 🟡 first Grafana dashboard (CMC API — RED + DB) checked in + auto-provisioned (P0.7 / ADR-0014); per-tenant + per-module dashboards pending |
| 14.8 | Health checks (live/ready/startup/deep/synthetic) | 🟡 liveness + readiness (200/503, pings PG/Redis/MinIO) + deep (per-dep timings, authed) (P0.8 / ADR-0015); startup + external synthetic pending |

---

## ToR §15 — Performance & scalability

| §15.x | Capability | Status |
|---|---|---|
| 15.1 | Horizontal scaling | 🔴 (single instance) |
| 15.2 | Caching (L1/L2/L3) | 🟡 Redis-backed session-active cache (P0.4); broader app cache pending |
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
