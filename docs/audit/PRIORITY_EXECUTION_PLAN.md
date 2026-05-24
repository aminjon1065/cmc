# PRIORITY EXECUTION PLAN
## Ordered backlog, with rationale, dependencies, and sequencing constraints

**Use this document as the day-1 backlog from where the code is today.**
Items are numbered so they can be referenced in commits and PRs.

### How items are ordered

Within each priority band, items are ordered by **earliest unblock value × lowest cost**: the cheapest moves that unblock the next batch land first. Across bands, **higher band wins**.

**Bands:**
- **P0 — Foundational**: items without which subsequent work is risky or impossible.
- **P1 — MVP**: items required to leave Horizon-0 and enter Horizon-1.
- **P2 — Beta**: items required to leave H1 and enter H2.
- **P3 — Production**: H2 → H3.
- **P4 — Enterprise scale**: H3 → H4.
- **P5 — National scale**: H4 → H5.

Each item carries:
- **Why** (the load-bearing reason).
- **Cost** (T-shirt: XS/S/M/L/XL/XXL).
- **Depends on** (prior items by number).
- **Unblocks** (subsequent items).

---

## P0 — Foundational (next 1–2 weeks)

These close gaps from current `main` that **cannot wait** for any new module.

### P0.1 — Rate limit on auth endpoints ✅ **COMPLETED 2026-05-25**
**Why:** without this, the first non-dev deployment is a brute-force target. Already called out in ADR-0002 and ADR-0003 §"known gaps."
**Cost:** S (1–2 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/src/common/rate-limit/{rate-limit.service.ts, rate-limit.module.ts, rate-limit.error.ts}`
- `apps/api/src/modules/auth/auth-rate-limit.specs.ts` — per-IP + per-email (SHA-256-hashed) specs
- Redis fixed-window counter (INCR + EXPIRE NX in MULTI), fail-open on Redis errors
- Per-spec audit on breach (`outcome='denied'`, durable through `runPrivileged`)
- `HttpExceptionFilter` translates `RateLimitExceededError` → 429 + `Retry-After` + problem+json
- `app.set('trust proxy', 'loopback, linklocal, uniquelocal')` in main.ts and test bootstrap
- 6 new env vars in `configuration.ts` with OWASP-aligned defaults (30/5min IP, 5/15min email, 60/5min refresh-IP)
- `truncateAll(sql, redis)` extended to wipe `cmc:auth:rate-limit:*` between tests
- 7 new e2e tests; full suite 43/43 green
- ADR-0009 captures the algorithm + thresholds + fail-open posture

**Deferred deliberately:**
- Global / non-auth rate limit → proxy layer at P0.9
- Prometheus breach counters → P0.7
- Per-tenant threshold overrides → P1.4 admin panel
- CAPTCHA / progressive friction → future hardening
**Unblocks:** any subsequent public deploy.

### P0.2 — Wire Redis into the API ✅ **COMPLETED 2026-05-25**
**Why:** Redis is deployed in compose, password-protected, AOF-on, but no application code touches it. Required by P0.1 (rate limit), P0.4 (session-active cache), P1.x (notifications), P2 (WS fanout).
**Cost:** S (½–1 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/src/modules/redis/{redis.tokens.ts, redis.module.ts, redis-keys.ts}`
- ioredis@5 with boot-time PING (fail-fast on misconfig)
- Lifecycle logger on connect/ready/reconnecting/end/error
- CI starts a `redis:7-alpine` container; teardown updated
- `apps/api/test/e2e/redis.e2e-spec.ts` — 4 tests, all pass
- ADR-0008 captures the tier-1 dependency commitment
- Test run: 5 suites · 36 tests · all green

**Deferred deliberately to later P0 items:**
- Prometheus metrics for Redis ops → P0.7
- Redis check in `/health/ready` → P0.8
- Tenant-scoped key builder + lint rule → wait for second tenant-scoped consumer
**Unblocks:** P0.1, P0.4, P1.6, P2.1.

### P0.3 — Structured JSON logs + request_id propagation ✅ **COMPLETED 2026-05-25**
**Why:** ToR §13.10 / §20.1 principle 7 ("Untraced is unfinished"). Current logs are unstructured stdout. Without `request_id` correlation, every incident investigation is a manual grep across processes. The audit_log schema already has `request_id` and `trace_id` columns waiting to be populated.
**Cost:** S (1 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/src/common/request-context/{request-context.service.ts, .module.ts, .middleware.ts}` — ALS-backed request_id service + middleware that validates inbound `X-Request-Id` (UUID-shape) or mints a fresh UUID v4
- `apps/api/src/common/logging/pino-options.ts` — centralised pino config (redact, serializers, mixin reading both ALS contexts)
- `nestjs-pino` + `pino-http` + `pino` + `pino-pretty` wired via `LoggerModule.forRootAsync`
- `bufferLogs: true` + `app.useLogger(app.get(PinoLogger))` in main.ts so bootstrap logs flow through pino too
- `RequestContextMiddleware` runs **before** `TenantContextMiddleware` so durable-audit / rate-limit-denial paths carry request_id
- `AuditService.toRow()` auto-populates `request_id` from ALS — every existing call site now correlates without changes
- `HttpExceptionFilter` includes `request_id` in problem+json body (and the header is set by the middleware)
- CORS `exposedHeaders: ["X-Request-Id"]` so the web app can read it from `fetch()` responses
- PII redact list: authorization, cookie, x-api-key, password, refreshToken (email visible — documented decision)
- 7 new e2e tests; full suite 50/50 green
- ADR-0010 captures the contract

**Deferred deliberately:**
- Loki + Promtail shipping → P1.7
- OTEL trace_id propagation → P0.6 (the ALS slot is reserved)
- Log rotation in compose → P0.9 (deploy)
**Unblocks:** P0.6 (OTEL), P1.x onward.

### P0.4 — Redis cache for session-active lookup ✅ **COMPLETED 2026-05-25**
**Why:** every authenticated request currently does one Postgres `SELECT FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > now()`. At scale this is the dominant query. Cache the (sid → active) tuple with TTL = access-token lifetime; invalidate on `revoke()`/`revokeFamily()`.
**Cost:** S (1 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/src/common/session-cache/{session-cache.service.ts, session-cache.module.ts}` — fail-open Redis-backed cache, `{userId, tenantId}` payload, batched delMany
- Middleware: cache-first lookup with payload-mismatch fall-through to DB; populate on DB-confirmed active
- `SessionsService` invalidates on every revoke path: `revoke()`, `revokeFamily()` (now `.returning({id})`), `rotate()` predecessor, replay-family-burn (now `.returning({id})`), `revokeExpired()`
- `SESSION_CACHE_TTL_SEC` env (default 900, matches `JWT_ACCESS_TTL` so failed DEL adds zero exposure beyond JWT expiry)
- `truncateAll(sql, redis)` broadened from `cmc:auth:rate-limit:*` to `cmc:auth:*` so session cache state also wipes between tests
- 7 new e2e tests covering populate / hit / DEL on logout / DEL on admin-revoke / DEL on rotate / DEL on family-burn / payload-mismatch fall-through
- Full suite 57/57 green
- ADR-0011 captures the contract + TTL rationale

**Deferred deliberately:**
- Cache hit/miss metrics → P0.7
- HA Redis (Sentinel) → P3.13
- Future encryption / sharding → H3
**Unblocks:** higher QPS without changing middleware. DB SELECT load on hot path drops orders of magnitude.

### P0.5 — Postgres backups
**Why:** no non-dev deployment is acceptable without backups. ToR §13.6.
**Cost:** S (1 d) for the cron + restore drill.
**How:** docker-compose sidecar running `pg_dump` to MinIO bucket `cmc-backups` nightly; rotation; a documented `pnpm db:restore <file>` script that runs against a fresh container.
**Depends on:** —.
**Unblocks:** P1 (deploy).

### P0.6 — OTEL HTTP + Postgres + S3 auto-instrumentation
**Why:** essential for any future debugging beyond log-grepping.
**Cost:** M (2–3 d).
**How:** `@opentelemetry/sdk-node` with `@opentelemetry/auto-instrumentations-node`. Single OTLP exporter pointing at a Tempo container added to compose. Add `trace_id` to the audit-log writer so audit rows can be joined to traces.
**Depends on:** P0.3.
**Unblocks:** P0.7 (metrics endpoint, since OTEL exposes metrics too).

### P0.7 — Prometheus `/metrics` endpoint + first dashboard
**Why:** RED metrics per route give the first capacity signal.
**Cost:** S (1 d) after P0.6.
**How:** `@opentelemetry/exporter-prometheus` or `prom-client` directly. Single Grafana dashboard checked into `infra/observability/dashboards/` with: HTTP req rate by route, error %, P50/P95/P99 latency, DB pool utilisation, Redis ops/sec.
**Depends on:** P0.6.

### P0.8 — Health endpoint extended to deep-probe
**Why:** ToR §14.8 differentiates liveness, readiness, deep.
**Cost:** XS (½ d).
**How:** `/health` (liveness) untouched. `/health/ready` probes Postgres `SELECT 1`, Redis `PING`, MinIO `HeadBucket`. `/health/deep` is admin-only and returns timings per dependency.
**Depends on:** P0.2.

### P0.9 — Caddy reverse-proxy + TLS in compose
**Why:** the platform cannot be deployed externally without TLS termination. ADR-0001 deferred this to "deploy step"; the deploy step is now.
**Cost:** S (1 d).
**How:** Caddy container in a `infra/deploy-compose.yml` overlay. Single `Caddyfile` with automatic Let's Encrypt. Forward `/v1/*` to the API, `/*` to the web. Configurable hostname per `infra/.env.production`.
**Depends on:** —.
**Unblocks:** any non-localhost deployment.

### P0.10 — App Dockerfiles for `apps/api` and `apps/web`
**Why:** today nothing pins runtime images; deploy is implicit `pnpm build && node dist`. ToR §13.1 (multi-stage, distroless, non-root, scanned).
**Cost:** S (1–2 d).
**How:** multi-stage builds. `node:22-bookworm-slim` for build; `gcr.io/distroless/nodejs22-debian12` for runtime. Non-root user. `.dockerignore` excludes test files.
**Depends on:** —.

### P0.11 — Tenants UI hardening: extract Tajikistan branding to data
**Why:** the dashboard hardcodes `Khatlon / GBAO / Sughd / DRS / Dushanbe`, the login mural hardcodes "Republic of Tajikistan." This is correct for the first tenant but pollutes the generic platform.
**Cost:** S (1 d).
**How:** `tenant_branding` table with `(tenant_id, locale_default, copy_blocks jsonb, theme jsonb, logo_url)`; render through a `Tenant`-aware server component layer. Seed populates the TJ-CMC values for the default tenant.
**Depends on:** —.
**Unblocks:** P2.x (multi-tenant onboarding).

---

## P1 — MVP (Horizon 1, weeks 3 → ~14)

### P1.1 — RBAC tables + `@Authorize` guard
**Why:** within-tenant access control absent today. Every authenticated user can read every document. This must land **before** any module where users have different responsibilities (Incidents, Cases, GIS-edit).
**Cost:** M (4–5 d).
**How:**
- Tables: `roles`, `permissions`, `role_permissions`, `user_roles`. All under RLS via existing tenant pattern.
- Permission schema: `(domain, action)` e.g., `('document', 'read')`.
- Guard `@Authorize('document:read')`. Resolves permissions per (user, tenant) from a Redis-cached set (invalidation event on `user.role_changed` / `role.permissions_changed`).
- System roles (`tenant_admin`, `auditor`, `operator`) seeded.
**Depends on:** P0.2 (Redis), P0.4 pattern.
**Unblocks:** P1.4 (Admin), P1.5 (Incidents), every subsequent module.

### P1.2 — MFA via TOTP
**Why:** ToR §6.11 default. Single-factor auth is not acceptable for the customers named in ToR §1.4.
**Cost:** M (3–4 d).
**How:** `user_mfa_methods` table (id, user_id, kind='totp', secret_encrypted, verified_at, last_used_at). Enrolment flow with QR + manual entry. Login flow extended with `mfa_required` outcome. Backup codes (one-time-use, argon2-hashed).
**Depends on:** —.
**Unblocks:** P1.3 (compliance posture).

### P1.3 — Password reset flow (admin-initiated + self-initiated email)
**Why:** today the seed script sets the admin password and there is no recovery. ADR-0002.
**Cost:** S (2 d).
**How:** admin-initiated reset writes a single-use token (hashed) to `password_resets`. Self-initiated emits an email with the token. Email delivery via P1.6.
**Depends on:** P1.1 (admin role), P1.6 (email channel).

### P1.4 — Admin Panel (Users / Roles / Tenants)
**Why:** ToR §3.19. Without an admin UI every operational task is a developer task.
**Cost:** L (1–2 wk).
**How:** Next.js server-component pages under `/admin/*` gated by `tenant_admin` role. CRUD via server actions. Step-up auth (re-auth challenge) for destructive actions. Confirmation token for bulk operations.
**Depends on:** P1.1.

### P1.5 — Incidents module (first new domain after Documents)
**Why:** the dashboard's whole premise. Today "Priority Incidents" is hardcoded copy.
**Cost:** L (2 wk).
**How:** schema (`incidents` with severity SEV-1..5, status, region, type, source, occurred_at, reported_by, resolved_at, summary, description, geometry-optional); endpoints (CRUD + transition); permissions (`incident:create`, `incident:assign`, `incident:resolve`); web UI under `/incidents`; dashboard "Priority Incidents" panel reads real data; audit on every transition; soft-delete.
**Depends on:** P1.1.

### P1.6 — Notifications (in-platform + email)
**Why:** the moment Incidents exist, someone must be notified.
**Cost:** L (1–2 wk).
**How:**
- `notifications` (id, tenant_id, user_id, kind, title, body, link, read_at, dispatched_at).
- Dispatcher service that subscribes to "domain trigger" events (initially direct service-call: `IncidentsService` → `NotificationsService`; later via event bus).
- Email worker via Nodemailer + a self-hosted Postfix sidecar (compose addition).
- MJML templates for the email channel.
- Per-user preferences (one row in `user_notification_prefs` per kind).
**Depends on:** P1.1, P1.5.

### P1.7 — Loki + Grafana in compose
**Why:** P0.3 made logs structured; this aggregates them.
**Cost:** S (1 d).
**How:** Loki + Promtail (or Grafana Agent) in `infra/observability-compose.yml`. Single Grafana dashboard with logs panel filtered by `request_id`.
**Depends on:** P0.3.

### P1.8 — Tempo + Alertmanager
**Why:** complete the observability triangle (logs / metrics / traces) before Phase-2's complexity arrives.
**Cost:** S (1 d).
**How:** Tempo container + OTLP receiver (P0.6 already emits). Alertmanager + 1 rule (5xx ratio > 1 % / 5 min). Webhook into an admin user's chat until P1.6 supports paging.
**Depends on:** P0.6, P0.7.

### P1.9 — API URL versioning (`/v1`)
**Why:** ToR §11.6. Cheaper to introduce now than after external consumers exist.
**Cost:** XS (½ d).
**How:** `app.setGlobalPrefix('v1')` + update `apps/web/src/lib/api.ts` base path + update Playwright fixtures.
**Depends on:** —.

### P1.10 — OpenAPI generation
**Why:** ToR §11.1 every endpoint defined in OpenAPI 3.1.
**Cost:** S (1–2 d).
**How:** `@nestjs/swagger` decorators on controllers + DTOs. Serve `/v1/openapi.json` (admin-gated for non-public endpoints). Optional Redoc page.
**Depends on:** P1.9.

### P1.11 — Audit log hash chain (tamper-evident)
**Why:** ToR §3.15. Columns exist; nothing populates them.
**Cost:** M (3–4 d).
**How:** SHA256 chain. Per-tenant chains keyed by `(tenant_id, occurred_at_day)` to avoid global serialisation. Daily Merkle root computed by a cron, anchored to MinIO with Object Lock (compliance mode).
**Depends on:** —.

### P1.12 — SIEM-ready audit export (Syslog + CEF)
**Why:** ToR §6.15. Even without a SIEM, the format is the contract.
**Cost:** S (1 d).
**How:** `audit-export` worker tail-reads `audit_log` and writes RFC 5424 + CEF to a configurable destination (file, syslog-over-TCP).
**Depends on:** —.

---

## P2 — Beta (Horizon 2, ~5–7 months solo / 6 months team)

### P2.1 — NATS JetStream + outbox + relay
**Why:** the event plane. Unblocks every cross-module reaction.
**Cost:** L (1–2 wk).
**How:**
- NATS container in compose.
- `outbox` table (id, tenant_id, aggregate_type, aggregate_id, event_type, version, payload, occurred_at, published_at, trace_id, causation_id).
- Writes happen in the same tx as the state-change.
- Relay process: poll outbox, publish to NATS subject `tenant.{tenant_id}.{aggregate_type}.{event_type}.v{version}`, update `published_at`. Idempotent (event_id is the dedup key).
- Standard envelope documented in `packages/contracts/src/events.ts`.
**Depends on:** P0.2.
**Unblocks:** P2.2, P2.3, P2.4.

### P2.2 — Audit-projection-to-ClickHouse consumer
**Why:** offload analytical queries from OLTP; long-term audit retention.
**Cost:** L (1 wk after CH up).
**Depends on:** P2.1, P2.5.

### P2.3 — WebSocket gateway (separate NestJS app)
**Why:** Realtime plane.
**Cost:** L (1–2 wk).
**How:** new app `apps/realtime` (NestJS w/ `@nestjs/websockets`). JWT verified on upgrade (shared `JWT_SECRET`). Subject pattern `tenant:X:domain:Y:resource:Z`. Subscribes to NATS subjects and re-publishes filtered by subscription patterns. Per-subscription permission check via P1.1 RBAC. Redis pub/sub for cross-instance fanout (forward-looking; single instance today).
**Depends on:** P2.1, P1.1.

### P2.4 — Notifications consumed from events
**Why:** decouple incident-triggers-notification from a direct service call.
**Cost:** M (3–5 d) refactor of P1.6.
**Depends on:** P2.1.

### P2.5 — ClickHouse single-shard
**Why:** analytical store.
**Cost:** M (1 wk to deploy + first MV).
**How:** CH container in compose. First materialised view: `incident_daily_stats_by_region` consuming the audit/event stream. Drizzle-equivalent for CH (raw SQL initially).
**Depends on:** P2.1 (events) or P0.x (Postgres ETL).
**Unblocks:** P2.2, P2.6.

### P2.6 — Dashboard data — replace hardcoded arrays
**Why:** the dashboard demo data has been visible since 0.0.1 — replace with CH-backed metrics.
**Cost:** M (3–5 d).
**How:** `MetricsService` in the API that runs ClickHouse queries; dashboard server component reads through `authedApiFetch('/v1/metrics/...')`.
**Depends on:** P2.5.

### P2.7 — GIS substrate (schemas + RLS + endpoints)
**Why:** the platform's spatial commitment. Phase-2 entry into the GIS plane.
**Cost:** L (2 wk).
**How:**
- `gis_layers` (id, tenant_id, name, kind, style jsonb, schema jsonb, source_uri, public flag, created_by, ...).
- `gis_features` (id, tenant_id, layer_id, geometry geometry(GeometryZ, 4326), properties jsonb, lifecycle metadata).
- GIST + tenant indexes.
- RLS on both tables.
- Endpoints: layer CRUD; feature CRUD; bbox-filtered list.
- Permissions: `gis:layer:read`, `gis:layer:edit`, `gis:feature:write`.
**Depends on:** P1.1.

### P2.8 — Custom NestJS tile server
**Why:** vector tiles per-tenant.
**Cost:** M (1 wk).
**How:** endpoint `/v1/gis/tiles/:layer/:z/:x/:y.mvt` that runs `ST_AsMVT(...)` against the tenant's `gis_features` filtered by the tile envelope. Cache-Control headers. Optional CDN-friendly signed URL variant.
**Depends on:** P2.7.

### P2.9 — MapLibre frontend
**Why:** users see the map.
**Cost:** L (1–2 wk).
**How:** `/map` route. MapLibre GL. Layer-toggle UI. Click → feature inspector right panel. Tile fetches go through `authedApiFetch`'s pattern (signed URL or short-lived bearer).
**Depends on:** P2.8.

### P2.10 — Cases module
**Why:** the second domain user-of-the-platform module.
**Cost:** L (2 wk).
**How:** per-tenant case types (config-driven), assignment policies, SLA timer (cron until Temporal arrives at P3.1), activity timeline, linked artifacts (incidents, documents, gis_features).
**Depends on:** P1.1, P1.5, P2.7.

### P2.11 — Postgres `tsvector` search
**Why:** OpenSearch is Phase-3; this is the interim.
**Cost:** M (3–5 d).
**How:** GIN index on `to_tsvector(name || ' ' || coalesce(description, ''))` for documents and incidents. Cross-domain `/v1/search` endpoint fanning out per-domain Postgres FTS queries and merging by score.

### P2.12 — Multipart upload + tus.io
**Why:** large-file handling. ToR §15.8.
**Cost:** M (1 wk).
**How:** tus.io server fronted by the API for the protocol semantics; bytes flow to MinIO via initiate-multipart + upload-part + complete-multipart.
**Depends on:** —.

### P2.13 — Preview generation worker
**Why:** every file UI gets ten times better with thumbnails.
**Cost:** L (1–2 wk).
**How:** BullMQ + Redis. Workers per file kind: image (sharp → WebP), PDF (pdftoppm → first-page PNG), video (ffmpeg → poster), audio (waveform PNG). On finalize → enqueue preview job → write preview key into `documents.metadata.previews`. Front-end shows previews when available.
**Depends on:** P0.2 (Redis for BullMQ).

### P2.14 — Vault dev mode + first secret migration
**Why:** stop bringing secrets in `.env` files into prod.
**Cost:** M (1 wk to integrate; ongoing for additional secrets).
**How:** Vault dev mode in compose. Cmc_app DB credentials sourced via Vault Agent sidecar template. Document the per-pod credential lease.

---

## P3 — Production (Horizon 3, ~9–12 months solo / 6 months team)

### P3.1 — Temporal self-hosted + first workflow
**Cost:** L (2 wk).
**Why:** durable, code-defined workflows. Replaces the cron-based SLA timers from P2.10.
**Depends on:** P2.1 (events to trigger workflows).

### P3.2 — Incident-response workflow
Workflow: severity-declared → assemble responders (by region + role) → page on-call → create war-room thread → SLA timers → reminders → post-mortem template generation.
**Depends on:** P3.1, P1.6.

### P3.3 — Folder model + permission inheritance for files
ToR §9.1, §9.2. `ltree` paths. Inheritance algorithm in service + decision cache.
**Depends on:** P1.1.

### P3.4 — Document versioning
`document_versions` child table. Storage-side copy-on-write (object dedup by content hash where MinIO supports it).
**Depends on:** P3.3.

### P3.5 — Retention policies + legal hold
Per-folder + per-document rules. Nightly retention sweeper. Legal-hold flag suspends deletion.
**Depends on:** P3.4.

### P3.6 — OpenSearch + permission-aware indexing
Phase-3 search.
**Depends on:** P1.1, P2.1.

### P3.7 — Federated search at `/v1/search`
Fan-out to OpenSearch + ClickHouse-aggregated metadata + Postgres FTS for transactional records.
**Depends on:** P3.6.

### P3.8 — Visual workflow builder (MVP)
React Flow + node library + compile-to-Temporal.
**Depends on:** P3.1.

### P3.9 — External API + API keys + per-tenant quota
**Depends on:** P1.1, Caddy / Kong decision.

### P3.10 — Wiki (without realtime collab yet)
Spaces, pages, TipTap editor, version history, comments.

### P3.11 — Data import workers
BullMQ jobs for CSV / Excel / GeoJSON / Shapefile with validation + quarantine.

### P3.12 — Chat MVP (no E2EE, no video yet)
Channels, threads, mentions, reactions; persisted to Postgres + projected to CH; realtime via P2.3.

### P3.13 — HA introduction
2× API instances; Postgres primary + replica; PgBouncer; Redis Sentinel.

### P3.14 — SOC 2 control mapping
Document control coverage and gaps. Begin evidence collection.

### P3.15 — Daily Merkle root anchoring
Extension of P1.11. Daily root committed to MinIO Object Lock bucket (compliance mode).

---

## P4 — Enterprise scale (Horizon 4)

### P4.1 — Realtime collaboration (Yjs)
Across documents (Wiki pages, dashboard editing, workflow diagrams). Presence cursors. Anchored comments. Offline reconcile. **Cost: XL.**

### P4.2 — Video conferencing (LiveKit + coturn)
SFU, TURN/STUN, recording via egress, calendar integration. **Cost: XL.**

### P4.3 — Operational Monitoring Center
Multi-monitor wall view, alert ticker, time-replay (consume event log). Lifts the disabled "Command Center" sidebar entry into reality.

### P4.4 — Mobile companion (React Native)
Field operations, approvals, alerts, map. Self-hosted UnifiedPush.

### P4.5 — Media management
FFmpeg transcoding workers, HLS streaming, watermarking.

### P4.6 — Multi-region (active-passive DR)
Logical replication, regional Tempo+Loki, DNS-level failover.

### P4.7 — Vault production
Dynamic DB credentials per pod, mTLS service mesh (Linkerd) for critical paths.

### P4.8 — Realtime analytics
ClickHouse Live Views or Flink. Anomaly detection on time-series.

---

## P5 — National scale (Horizon 5)

### P5.1 — LLM gateway (self-hosted)
vLLM serving Llama 3.x / Qwen / Mistral on internal GPUs. Per-tenant rate-limit + audit.

### P5.2 — Vector pipeline + Qdrant
Migrate or supplement pgvector. Embedding workers consuming the event stream.

### P5.3 — Semantic search
Hybrid BM25 + vector kNN. Permission-aware retrieval.

### P5.4 — RAG framework
Retrieval → context → LLM → citations → audit.

### P5.5 — Per-module copilots
GIS, Documents, Workflow, Incidents.

### P5.6 — Document intelligence (OCR + classification + extraction)
Tesseract / PaddleOCR / docTR pipeline.

### P5.7 — Multi-region active-active
Selective replication per domain.

### P5.8 — Sovereign / airgapped installers
For deployments that cannot reach the public internet.

### P5.9 — Edge intelligence
Local inference for low-connectivity regions.

### P5.10 — Federation
Cross-tenant collaboration when opted in.

---

## Cross-cutting threads (always on)

| Thread | Owner | Cadence |
|---|---|---|
| Tech debt — see [TECH_DEBT_REGISTER.md](./TECH_DEBT_REGISTER.md) | All engineers | One thread per sprint |
| Dependency upgrades (Dependabot) | Whoever takes the PR | Weekly |
| CVE response | Security owner | As needed |
| Pen tests | External / internal | Annually + post-major-change |
| Load tests (k6) | SRE / platform | Release-gate per horizon exit |
| Chaos drills | SRE | Quarterly from H3 onward |
| DR drills | SRE | Quarterly from H3 onward |
| Documentation upkeep (ADRs, runbooks, READMEs) | Author of the change | Every change |

---

## Sequencing rules of thumb

- **No new module before P1.1 (RBAC).** Every additional module without RBAC compounds the access-control debt.
- **No public deploy before P0.1, P0.5, P0.9.** Auth rate-limit, backups, TLS.
- **No realtime feature before P2.1 + P2.3.** Event plane + WS gateway are the substrate.
- **No GIS feature before P1.1 + P2.7.** Permissions on layers and features are intrinsic to the model.
- **No analytics dashboard with real data before P2.5.** Otherwise it is OLTP-scanning.
- **No AI feature before P5.1 + P5.2.** Vector + LLM gateway are the substrate.

---

## Reading this plan with the roadmap

This plan is the **inside view** of [ROADMAP.md](./ROADMAP.md):

| Roadmap horizon | Plan bands |
|---|---|
| H0 → H1 | P0 + P1 |
| H1 → H2 | P2 |
| H2 → H3 | P3 |
| H3 → H4 | P4 |
| H4 → H5 | P5 |

A horizon exits when all items in the corresponding bands are merged + tested + observable.
