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

### P0.5 — Postgres backups ✅ **COMPLETED 2026-05-25**
**Why:** no non-dev deployment is acceptable without backups. ToR §13.6.
**Cost:** S (1 d) for the cron + restore drill. **Actual: ½ d.**
**Delivered:**
- `infra/backup/{Dockerfile, entrypoint.sh, backup.sh, restore.sh}` — alpine + `postgresql16-client` + `mc` (pinned to the same release `minio-init` uses) + busybox crond
- `postgres-backup` service in `infra/docker-compose.yml` running `crond -f -l 8`; `depends_on` includes `postgres` (healthy), `minio` (healthy), `minio-init` (completed) so the bucket is guaranteed present before first run
- `pg_dump --format=custom --compress=9` → `minio/cmc-backups/postgres/YYYY/MM/cmc-<ISO-Z>.dump`; rotation via `mc rm --older-than ${BACKUP_RETENTION_DAYS}d` (default 7d)
- 5 new env vars in `infra/.env.example` (`BACKUP_BUCKET`, `BACKUP_RETENTION_DAYS`, `BACKUP_SCHEDULE_CRON`, `BACKUP_RUN_ON_START`, `BACKUP_TZ`) — default schedule `0 3 * * *` UTC
- `pnpm db:backup` → one-shot manual run via `docker compose exec -T`
- `pnpm db:restore <key|latest>` → DROP+CREATE+`pg_restore --exit-on-error`; TTY prompt requires retyping the DB name; for scripted callers, `CONFIRM_RESTORE=yes` is forwarded via `docker compose exec -e CONFIRM_RESTORE` (the var-name-only form passes the host value through, so no `=yes` hardcoded into the pnpm script — the safety prompt remains opt-out, not opt-in)
- Restore drill rehearsed end-to-end against the live dev DB: backup → insert marker → `restore latest` → marker absent, baseline counts (users, sessions, audit, extensions, roles, RLS-force) all match; then time-targeted explicit-key restore proven by an A-then-B marker pair where the named snapshot kept A and dropped B; `cmc_app` runtime role still reads post-restore (GRANTs preserved in dump); full e2e suite re-run 57/57 green
- ADR-0012 captures the design + the "what we deliberately did not do"

**Deferred deliberately:**
- WAL streaming / PITR → P3 (when RPO contract tightens below 24 h)
- Prometheus metric for backup success/failure → P0.7
- Alertmanager rule "no fresh backup in 36 h" → P1.8
- Application-layer encryption of dump bytes → P2.14 (Vault)
- MinIO content backup (document bytes) → separate item
- Cross-region off-site replication → deploy-time concern
- Restore verification gate in CI → cheap follow-on once Docker-in-CI stabilises
**Unblocks:** P1 (first deploy).

### P0.6 — OTEL HTTP + Postgres + S3 auto-instrumentation ✅ **COMPLETED 2026-05-25**
**Why:** essential for any future debugging beyond log-grepping.
**Cost:** M (2–3 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/src/tracing.ts` — `@opentelemetry/sdk-node` + `getNodeAutoInstrumentations()`, started as an import side-effect; first import in `main.ts` (`dist/main.js` begins `require("./tracing")`) so it patches http/express/nestjs/aws-sdk/ioredis before they load. `fs`/`net`/`dns` disabled as noise.
- Exporter gated on config: OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` set (P1.8/Tempo), console when `OTEL_TRACES_CONSOLE=true`, else **no export but spans still created** (so trace_id + W3C propagation work with zero connection-refused noise). `OTEL_ENABLED=false` kill switch.
- trace_id flows via the existing P0.3 ALS: `RequestContext.traceId` + `get/setTraceId`; `RequestContextMiddleware` captures the active span, stamps the ALS, echoes **`X-Trace-Id`**; pino `customProps` adds `traceId`; `AuditService.toRow()` defaults `trace_id` from the ALS (same pattern as request_id) — closes the trace_id half of TD-008.
- DB spans emitted manually at the two GUC chokepoints (`db.tx tenant` / `db.tx privileged`, attrs `db.system`,`cmc.db.scope`) because postgres-js has no OTEL auto-instrumentation; S3 spans via the aws-sdk instrumentation; Redis spans via ioredis instrumentation (freebie).
- 6 OTEL env vars added to the zod schema + `apps/api/.env(.example)` + `.env.test(.example)`.
- `test/tracing-setup.ts` starts tracing in the test process; `tracing.e2e-spec.ts` (5 tests) asserts X-Trace-Id, inbound W3C traceparent adoption, and trace_id on audit rows (success + durable-failure). Full suite **62/62 green** (was 57 + 5 new), zero regressions — validated against `cmc-postgres` on an alternate host port (5433) because a co-resident project held 5432 at validation time.
- Manual emit check (`OTEL_TRACES_CONSOLE=true`, built `dist/`): emitted `GET`/`POST` HTTP spans, nested `middleware - RequestContextMiddleware`/`TenantContextMiddleware` + `request handler` spans, and **both** `db.tx tenant` + `db.tx privileged` with `db.system=postgresql` / `cmc.db.scope`; ioredis instrumentation active (connect span); no exporter errors. `dist/main.js` confirmed to start with `require("./tracing")`.
- ADR-0013 captures the design + deliberate gaps.
- **Build gotcha fixed:** adding `@opentelemetry/api` to `apps/api` made it resolve a *second* drizzle-orm peer-variant (`…_@opentelemetry+api_@types+pg_…`) distinct from `packages/db`'s, producing ~96 `SQL<unknown>` "separate declarations of private property" type errors. Resolved by adding `@opentelemetry/api` + `@types/pg` to `packages/db` devDependencies so both workspaces resolve the identical drizzle variant. Verified: both `node_modules/drizzle-orm` symlinks point to the same store path; `pnpm typecheck` 4/4 clean; `--frozen-lockfile` consistent.

**Deferred deliberately:**
- Tempo container + OTLP receiver → P1.8 (this item "already emits"; turning it on is one env var)
- Statement-level DB spans → await a postgres-js instrumentation or a `pg` migration
- Metrics pipeline → P0.7; log shipping (Loki) → P1.7
- Ratio sampling (set `OTEL_TRACES_SAMPLER` via env when volume warrants — no code change)
- trace_id in the problem+json body (it's in the X-Trace-Id header today)
**Depends on:** P0.3.
**Unblocks:** P0.7 (metrics endpoint, since OTEL exposes metrics too); P1.8 (Tempo).

### P0.7 — Prometheus `/metrics` endpoint + first dashboard ✅ **COMPLETED 2026-05-25**
**Why:** RED metrics per route give the first capacity signal.
**Cost:** S (1 d) after P0.6. **Actual: ½ d.**
**Delivered:**
- `apps/api/src/modules/metrics/{metrics.service,metrics.middleware,metrics.controller,metrics.module}.ts` — `prom-client` with a **dedicated Registry** (avoids "already registered" across jest app rebuilds); `collectDefaultMetrics` for Node process metrics.
- RED: `http_request_duration_seconds` histogram (method, route, status_code) — rate via `_count`, errors via `status_code`, latency via buckets. Route label is the **matched pattern** (`/auth/sessions/:id`), never the concrete URL; unmatched → `<unmatched>`. Cardinality guard asserted in tests.
- DB saturation: `cmc_db_transactions_in_flight` gauge + `cmc_db_transactions_total{scope,outcome}` counter + `cmc_db_pool_max` gauge, sourced at the single tx chokepoint (`TenantDatabaseService.withSpan`) because postgres-js has no public live pool-stat API.
- `GET /metrics` — anonymous + unversioned like `/health`; `METRICS_ENABLED` gates recording. Excluded `/metrics` + `/health*` from the RED histogram via `req.originalUrl` (NestJS rewrites `req.path` to the middleware mount — gotcha documented).
- `infra/observability-compose.yml` (Prometheus v2.54 + Grafana 11) with `pnpm obs:up/down/logs/reset/ps`; scrapes `host.docker.internal:3001`; Grafana auto-provisions the datasource + loads `infra/observability/grafana/dashboards/cmc-api-red.json` (RED + DB + Node rows).
- `METRICS_ENABLED` added to zod schema + all four env files.
- `metrics.e2e-spec.ts` (7 tests): exposition format/content-type, family HELP lines, RED increments with normalised route label, **no UUID leak**, `/metrics`+`/health` excluded, DB tx counter + pool_max. Full suite **69/69 green** (was 62 + 7 new), zero regressions — validated against `cmc-postgres` on alt port 5433 (gbv holds 5432).
- Live scrape confirmed: 14 KB exposition, all families present, `cmc_db_pool_max 20`, content-type `text/plain; version=0.0.4`.
- ADR-0014 captures the design + the prom-client-vs-OTEL and in-flight-vs-pool decisions.

**Deferred deliberately:**
- Alertmanager + rules → P1.8 (these series are the inputs)
- Business metrics (sessions, documents, login outcomes) → P1.x per-module
- `tenant_id` label / per-tenant breakdown → H1 cardinality decision
- Exact connection-pool stats → await a node-`pg` migration
- /metrics auth/network restriction → P0.9 (Caddy)
- Scrape target → compose service DNS once app Dockerfiles land (P0.10)
**Depends on:** P0.6.

### P0.8 — Health endpoint extended to deep-probe ✅ **COMPLETED 2026-05-25**
**Why:** ToR §14.8 differentiates liveness, readiness, deep.
**Cost:** XS (½ d). **Actual: ¼ d.**
**Delivered:**
- `apps/api/src/modules/health/health.service.ts` — parallel, timeout-bounded probes: Postgres (`client\`select 1\``), Redis (`ping`→PONG), MinIO (`StorageService.probeReachable` → `HeadObject` on a sentinel key). Each `Promise.race` vs `HEALTH_PROBE_TIMEOUT_MS` (default 2000) so a hung dep can't hang the endpoint.
- `/health` (liveness) untouched — never touches a dep. `/health/ready` — anonymous, **200 ready / 503 not_ready** (LB routes on status code), lean per-dep up/down body. `/health/deep` — `JwtAuthGuard`, always 200, per-dep `{status, latencyMs, error?}` + overall `ok|degraded`.
- `/health/deep` auth: **authenticated** now; true admin role-gating deferred to P1.1 (no roles exist yet) — documented in ADR-0015.
- MinIO probe via `StorageService` (the module's public export), not the raw `S3_INTERNAL` token — correct DI boundary. Uses `HeadObject` not `HeadBucket` (S3-generic + jest-VM-safe).
- Shared contract types in `@cmc/contracts` (`ReadinessResponse`, `DeepHealthResponse`, `DependencyStatus`, `HealthDependencyName`); contracts rebuilt to dist.
- `HEALTH_PROBE_TIMEOUT_MS` added to zod + all four env files. MetricsMiddleware already excludes `/health/*`; pino already ignores `/health/ready`.
- `health.e2e-spec.ts` (5 tests): liveness; ready 200 all-up; ready anonymous; deep 401 unauth; deep 200 authed with per-dep latencyMs. Full suite **73/73 green** (68 + 5), zero regressions.
- Live-validated: ready 200 all-up; **dead-S3 instance → liveness still 200, ready 503 + minio down** (pg/redis up, returned promptly under timeout); deep 401 unauth.
- ADR-0015 captures the liveness-never-touches-deps + timeout-bounding + auth-interim + jest-vm-flag decisions.

**Deferred deliberately:**
- `/health/deep` role-gate (`platform_admin`/`tenant_admin`) → P1.1 (RBAC); one-line guard swap
- `/health/startup` → when a slow-boot path exists
- External synthetic monitor → H1 (OBSERVABILITY_REVIEW §5.3)
- New deps (NATS/ClickHouse/OpenSearch) → one probe each at their item
**Depends on:** P0.2.

### P0.9 — Caddy reverse-proxy + TLS in compose ✅ **COMPLETED 2026-05-25**
**Why:** the platform cannot be deployed externally without TLS termination. ADR-0001 deferred this to "deploy step"; the deploy step is now.
**Cost:** S (1 d). **Actual: ¼ d.**
**Delivered:**
- `infra/caddy/Caddyfile` — automatic TLS (Let's Encrypt in prod, internal CA for `*.localhost`), fully env-driven hosts + upstreams. `(common)` snippet: HSTS + nosniff + X-Frame DENY + Referrer-Policy + `-Server` + zstd/gzip. `caddy validate` clean (formatted, no warnings).
- **Subdomain routing, not path** (deliberate deviation from the plan's "`/v1/*`→API"): there is no `/v1` yet (P1.9) and the API's bare paths collide with web routes (`/documents` is both an API resource and a web page). So `{$APP_HOST}`→web, `{$API_HOST}`→API. Documented in ADR-0016.
- **Ops endpoints blocked at the edge** — `(block_ops)` responds 404 to `/metrics` + `/health/deep` (closes the deferred network-restriction follow-ons from ADR-0014 + ADR-0015); `/health/ready` stays reachable for LBs.
- `infra/deploy-compose.yml` overlay (`caddy:2.8-alpine`, 80/443 + 443/udp HTTP/3, persisted `caddy_data`/`caddy_config` volumes, `extra_hosts: host-gateway`) + `infra/.env.production.example`. `pnpm deploy:up/down/logs/ps/validate`.
- Upstreams default to `host.docker.internal:{3001,3000}` (apps on host until P0.10); flip to `api:3001`/`web:3000` after P0.10 via one env edit — noted inline.
- **Live-validated** with the internal CA: certs issued for `localhost` + `api.localhost`; HTTPS/2 → API `/health` 200; `/metrics` 404; `/health/deep` 404; `/health/ready` 200; HTTP→HTTPS 308.
- ADR-0016 captures the subdomain rationale, ops-block, host→compose-DNS transition, and the no-`header_up` finding.

**Deferred deliberately:**
- Edge rate-limiting / OWASP CRS WAF → later hardening (the `(common)` snippet is the attach point); ToR §3.17
- mTLS service-to-service → P4 (this is edge TLS only)
- HSTS `preload` → opt in when the domain is HTTPS-committed
- web→API host + CORS values → deploy-env config (runbook), not code
**Depends on:** —.
**Unblocks:** any non-localhost deployment.

### P0.10 — App Dockerfiles for `apps/api` and `apps/web` ✅ **COMPLETED 2026-05-25**
**Why:** today nothing pins runtime images; deploy is implicit `pnpm build && node dist`. ToR §13.1 (multi-stage, distroless, non-root, scanned).
**Cost:** S (1–2 d). **Actual: ½ d.**
**Delivered:**
- `apps/api/Dockerfile` — multi-stage: `node:22-bookworm-slim` build (corepack pnpm, frozen install w/ cached store, build contracts+db+api, `pnpm --filter @cmc/api --prod deploy /prod`) → `gcr.io/distroless/nodejs22-debian12:nonroot` runtime, `USER nonroot`, `CMD ["dist/main.js"]`. ~403 MB. argon2 native binary ABI-compatible (build + runtime both Debian 12/glibc).
- `apps/web/Dockerfile` — Next standalone build → distroless `:nonroot` runtime, `CMD ["apps/web/server.js"]`. ~321 MB. `next.config.ts` gains `output:"standalone"` + `outputFileTracingRoot` (repo root). `NEXT_PUBLIC_API_BASE_URL` is a build-arg (inlined); server-side `API_BASE_URL` is runtime.
- Single root `.dockerignore` (context = monorepo root; excludes node_modules/dist/.next/tests/docs/`.env*`).
- **Non-root verified** (uid 65532) for both — caught + fixed that the distroless default/`:latest` tag runs as ROOT; pinned `:nonroot` + explicit `USER`.
- `infra/deploy-compose.yml` now builds + runs `api` + `web`; **Caddy upstreams flipped** to `api:3001`/`web:3000` (the ADR-0016 §5 transition); `api` joins external `cmc-net` to reach data services by name. `.env.production.example` updated; healthchecks via bundled node / Caddy `:80`.
- **Config hardening** (one app-code change): `emptyAsUndefined` zod preprocessor so an empty `OTEL_EXPORTER_OTLP_ENDPOINT=` (compose idiom) is treated as unset instead of crashing boot on `.url()`. Guarded by `config.e2e-spec.ts` (4 tests).
- **Full-stack live-validated**: `pnpm infra:up` + `pnpm deploy:up` → all 3 containers healthy → Caddy→API `/health` 200 (HTTP/2), `/health/ready` 200 **all deps up incl. minio via service name**, `/metrics` 404, web 200. Suite **77/77** (73 + 4 config), typecheck/lint/web-typecheck clean.
- ADR-0017 captures the distroless/non-root, pnpm-deploy, Next-standalone, argon2/glibc, and empty-env decisions.

**Deferred deliberately:**
- Image scanning (Trivy/Grype) + SBOM → CI follow-on (TD-029)
- CI build-and-push to a registry → deploy-automation item
- `pnpm deploy` source-copy prune (slightly fat image) → minor tightening
- Secrets via Vault instead of compose env → P2.14 (TD-005)
**Depends on:** —.

### P0.11 — Tenants UI hardening: extract Tajikistan branding to data ✅ **COMPLETED 2026-05-25**
**Why:** the dashboard hardcodes `Khatlon / GBAO / Sughd / DRS / Dushanbe`, the login mural hardcodes "Republic of Tajikistan." This is correct for the first tenant but pollutes the generic platform.
**Cost:** S (1 d). **Actual: ½ d.**
**Delivered:**
- `tenant_branding` table (`tenant_id` PK+FK→tenants cascade, `locale_default`, `logo_url`, `copy` jsonb, `theme` jsonb, timestamps) + migration `0005` with RLS (two-GUC tenant isolation + FORCE, like every tenant table).
- `@cmc/contracts` branding types + **vendor-neutral `DEFAULT_BRANDING`** (no TJ specifics — used for no-row / missing-key / no-tenant fallback so the frontend always gets a complete object).
- `GET /branding` — public + **context-aware**: authed → own tenant row (tenant tx); anonymous (login, root metadata) → `DEFAULT_TENANT_SLUG` tenant via privileged lookup; both fall back to `DEFAULT_BRANDING`. `BrandingModule/Service/Controller` + `DEFAULT_TENANT_SLUG` config.
- **TJ-CMC values live in exactly one place** — `apps/api/src/scripts/seed-branding.ts` (`TJ_CMC_BRANDING`), upserted by the seed. No app code references it.
- Web: `lib/branding.ts` (`getPublicBranding`/`getBranding`, cached, fallback-safe). Replaced all hardcoded strings — `login` mural, `layout` (`generateMetadata` + dynamic `lang`), `sidebar` (props via `AppShell`), dashboard `statusLocation`. **Grep-clean: no TJ strings left in web src.**
- `branding.e2e-spec.ts` (6 tests): anonymous→default, missing-key fill, no-tenant→generic, authed→own, **second-tenant isolation (no leak)**, missing-row→generic. Full suite **83/83 green** (77 + 6). Workspace typecheck 0, api/web lint clean, web build clean (pages → dynamic, intended).
- Live-validated: seed→DB→`GET /branding` returns full TJ-CMC copy anonymously.
- ADR-0018 captures the context-aware endpoint, generic-vs-seed split, pre-auth default path, and the branding-vs-demo-data boundary.

**Deferred deliberately:**
- Dashboard **demo data** (regions, incident counts, ribbon) → TD-022 / P1.5 / P2.6 (NOT branding)
- `theme` per-tenant tokens → TD-023 (design system); column shipped empty
- Branding editor UI → P1.4 (Admin Panel); logo-asset pipeline → future
**Depends on:** —.
**Unblocks:** P2.x (multi-tenant onboarding).

> **🏁 P0 band COMPLETE (P0.1 → P0.11).** The foundational layer is done: auth rate-limit, Redis, structured logs + request_id, session cache, backups, OTEL traces, Prometheus metrics, health probes, TLS edge, app images, and tenant branding. Next: **P1.1 (RBAC)** — the gate before any new domain module — then **P1.5 (Incidents)**, the first user-visible platform feature.

---

## P1 — MVP (Horizon 1, weeks 3 → ~14)

### P1.1 — RBAC tables + `@Authorize` guard ✅ **COMPLETED 2026-05-25**
**Why:** within-tenant access control absent today. Every authenticated user can read every document. This must land **before** any module where users have different responsibilities (Incidents, Cases, GIS-edit).
**Cost:** M (4–5 d). **Actual: ~1 d.**
**Delivered:**
- Tables `permissions` (GLOBAL catalog, RLS read-all/write-bypass), `roles` (per-tenant, RLS), `role_permissions` (RLS via parent role), `user_roles` (per-tenant, RLS) + migration `0006`. Permission schema `(domain, action)`.
- `@cmc/contracts`: `PERMISSION_CATALOG` + `SYSTEM_ROLES` as the single source of truth for both seed and guard (can't drift). Catalog: `document:{read,write,delete}`, `session:read`, `audit:read`, `role:{read,assign}`.
- `@Authorize('document:read')` decorator + `AuthorizeGuard` (ALL-required; no metadata → not gated; missing perm → **403 + durable `rbac.access.denied` audit**). **Caught + documented the NestJS guards-run-before-interceptors trap** — `resolvePermissions` opens its own `runForTenant` tx (the ambient tenant tx doesn't exist at guard time).
- `PermissionCacheService` (Redis, `cmc:authz:perms:<tenant>:<user>`, TTL `RBAC_PERM_CACHE_TTL_SEC`=300, **fail-open to DB** like the session cache) + invalidation on assign/remove. `RbacService` (resolve/hasPermission/listRoles/listUserRoles/assign/remove/enforce).
- `RbacController`: `GET /rbac/roles`, `GET /rbac/users/:id/roles`, `POST/DELETE /rbac/users/:id/roles[/:roleId]` (gated `role:read`/`role:assign`).
- **Documents protected**: `@Authorize` on every route (read/write/delete) — closes TD-003 in practice. System roles seeded per tenant; seeded admin granted `tenant_admin`.
- `rbac.e2e-spec.ts` (9 tests): role-based document access (admin/operator/auditor/no-role), 403+denied-audit, roles-list, **assign→immediate access (cache invalidation)→remove→revoked**, cross-tenant role isolation. Full suite **92/92 green** (83 + 9; documents adapted via fixtures granting tenant_admin). Workspace typecheck 0, lint clean.
- Live-validated: seed→login→guard→cache→enforce: admin 200 + full CRUD, anon 401, under-privileged 403.
- ADR-0019 captures per-tenant-roles/global-catalog, the guard-tx ordering fix, cache + invalidation, and the ABAC-deferred boundary.

**Deferred deliberately:**
- ABAC / OPA (Rego attribute policies) → later layer (the `enforce` chokepoint is the attach point); ToR §3.3/§6.2
- Custom-role CRUD + permission editing → P1.4 (Admin Panel); tables already support it
- `/health/deep` role-gate (ADR-0015 follow-on) → one-line swap, not done to keep scope tight
- Authz cache hit/miss metrics → future P0.7 counter; system-role immutability DB-trigger → with role-edit API
**Depends on:** P0.2 (Redis), P0.4 pattern.
**Unblocks:** P1.4 (Admin), P1.5 (Incidents), every subsequent module.

### P1.2 — MFA via TOTP ✅ **COMPLETED 2026-05-25**
**Why:** ToR §6.11 default. Single-factor auth is not acceptable for the customers named in ToR §1.4.
**Cost:** M (3–4 d). **Actual: ~1 d.**
**Delivered:**
- `user_mfa_methods` (secret **encrypted at rest**, AES-256-GCM via `SecretBoxService` + `MFA_ENC_KEY`) + `mfa_backup_codes` (argon2id, one-time) tables under RLS + migration `0007`.
- **Two-step login via a stateless `mfa_token`** (no half-sessions): `/auth/login` with a verified factor returns `{ status: "mfa_required", mfaToken }`; `/auth/mfa/verify { mfaToken, code }` issues the real session. No-MFA login is tagged `status: "ok"` (additive discriminator — no contract break). Shared `issueSession()` so both paths can't drift.
- **Confirm-before-active enrolment**: `POST /auth/mfa/enrol` (secret + otpauth URI + QR data-URL) → `POST /auth/mfa/confirm {code}` sets `verified_at` + returns 10 one-time backup codes. `status` distinguishes pending vs enabled.
- Management endpoints (JwtAuthGuard): enrol, confirm, status, disable, backup-codes/regenerate. `/auth/mfa/verify` rate-limited (ADR-0009 bucket). Every transition audited.
- otplib **v12** (CJS) pinned — v13 is ESM-only and broke the jest/ts-jest CJS suite (`@scure/base`). `window: 1` (±30s skew). Config: `MFA_ENC_KEY` (32-byte, validated), `MFA_TOKEN_TTL_SEC`, `MFA_ISSUER`, `MFA_BACKUP_CODE_COUNT`.
- `mfa.e2e-spec.ts` (8 tests): no-MFA unchanged, enrol/QR, confirm wrong/right, login→mfa_required, verify wrong→401/TOTP→session, **backup code one-time**, disable. Full suite **100/100** (92 + 8), workspace typecheck 0, lint clean, web build clean.
- **Live-validated end-to-end** with real TOTP codes: enrol→confirm→mfa_required→verify→session, backup one-time (200 then 401), disable→single-step.
- ADR-0020 captures the stateless-mfa_token, secret-at-rest, confirm-before-active, no-SMS, and otplib-v12 decisions.

**Deferred deliberately:**
- `MFA_ENC_KEY` → Vault (P2.14, TD-005); key-rotation re-encryption job → with Vault
- Per-tenant/role "MFA required" enforcement policy + admin "reset MFA" → P1.4 (Admin Panel)
- Web enrolment UI → future (QR data-URL ready); WebAuthn/FIDO2 second factor → later
- "Remember this device" + single-use mfa_token jti → future hardening
**Depends on:** —.
**Unblocks:** P1.3 (compliance posture).

### P1.3 — Password reset flow ✅ **COMPLETED 2026-06-01**
**Why:** today the seed script sets the admin password and there is no recovery. ADR-0002.
**Cost:** S (2 d). **Actual: ~0.5 d.**
**Delivered:**
- `password_resets` table (single-use, **sha256-hashed** 256-bit token, `expires_at`, `used_at`, `created_by`) under RLS (two-GUC) + migration `0008`. Only the hash is stored — a DB dump can't reset a password. One live token per user (minting burns the prior unused one).
- **Self-service, no enumeration**: `POST /auth/password/forgot {email}` **always** 204; mints + notifies only on an exactly-one active-user match (privileged cross-tenant lookup); 0 or ambiguous matches are silent no-ops. `POST /auth/password/reset {token,newPassword}` completes it.
- **Admin-initiated**: `POST /auth/password/admin-reset/:userId` runs in the admin's tenant tx (RLS confines the target — cross-tenant is 404), returns `{token,expiresAt}` to relay out-of-band. Gated by the new **`user:manage`** permission (`tenant_admin` only; operator/auditor → 403).
- **Race-safe completion**: cheap pre-check before argon2 (hash-DoS guard), hash computed outside the tx, then one tx does a **CAS consume** (`used_at IS NULL AND expires_at > now()`) → set new hash → **revoke ALL sessions** (reason `password_reset`) + cache-del. Invalid/used/expired all return a generic 400.
- **Reset changes ONLY the password — MFA stays** (verified: post-reset login still hits the MFA gate; factor row intact).
- **Pluggable notifier** behind `PASSWORD_RESET_NOTIFIER`: `DevLogResetNotifier` logs the link in dev and **refuses to log in prod** (drops + warns). P1.6 swaps in SMTP via one `useClass` line.
- Rate-limited (ADR-0009 factory): forgot per-IP **and** per-email (3/h anti-spam); reset per-IP. Every transition audited (`password.reset_requested` self/admin; `password.reset_completed` success atomic, failures durable).
- `password-reset.e2e-spec.ts` (11 tests): no-enumeration, hashed/single-use token, expiry, session-revoke, admin-channel + 403 gate + cross-tenant 404, MFA-preserved. Full suite **111/111** (100 + 11), workspace typecheck 0, API lint 0 errors, web typecheck/lint clean.
- **Live-validated end-to-end** against the dev DB: real `DevLogResetNotifier` link → reset → old pw 401 / new pw 200; token reuse 400; durable failure-audit present.
- ADR-0021 captures the hashed-single-use-token, no-enumeration, admin-returns-token, race-safe CAS, reset-preserves-MFA, and pluggable-notifier decisions.

**Deferred deliberately:**
- Email delivery → P1.6 (SMTP notifier binding swap; move onto a retriable outbox)
- Ambiguous-email (same address in two tenants) self-reset stays a no-op until a tenant hint exists → recover via admin
- Password-policy hardening (complexity/breach-list/history) → future (shared with login/signup)
**Depends on:** P1.1 (admin role) ✅. **Email channel (P1.6) deferred — notifier seam keeps the swap to one line.**
**Unblocks:** P1.6 (email channel has its first consumer).

### P1.4 — Admin Panel (Users / Roles / Tenants) ✅ **COMPLETED 2026-06-01 (all 4 phases)**
**Why:** ToR §3.19. Without an admin UI every operational task is a developer task.
**Cost:** L (1–2 wk).
**How:** Next.js server-component pages under `/admin/*` gated to admins. CRUD via server actions. (ADR-0022.)
**Phased delivery** (each a complete cycle):
- **P1.4a — Foundation ✅ COMPLETED 2026-06-01.** `GET /rbac/me` (current user's effective roles+permissions; no `@Authorize` — self-scoped) + zod contract. Web: `getMyAccess()` (`lib/access.ts`, React-`cache()`-memoised, **fail-closed**), `/admin` layout redirect for non-admins (`isAdmin` = holds `user:manage`), `/admin` overview page, sidebar "Administration" enabled only for admins, middleware protects `/admin`. The API stays the real authz boundary (every admin endpoint `@Authorize`-gated); the web redirect is UX. 4 new e2e (`/rbac/me`: admin/role-less/401/self-scoped-operator); suite **115/115**; web build green; `/rbac/me` live-validated (admin shows `user:manage`). ADR-0022.
- **P1.4b — Users ✅ COMPLETED 2026-06-01.** UsersController (`GET/POST/PATCH/DELETE /users`, all `user:manage`-gated, RLS → cross-tenant 404). **Passwordless invite** → admin-reset (P1.3) sets first password (no email yet). Deactivate/soft-delete **revoke all sessions** + block re-login; **self-deactivate/delete guarded** (403). Initial roles granted inline in the insert's tx; role mgmt reuses `/rbac/users/:id/roles`. Audited (`user.created/updated/deactivated/deleted`). **`SessionsService` extracted to `SessionsModule`** (decouples from AuthModule — no DI cycle). Web `/admin/users` (list + create form + per-row activate/deactivate/reset-reveal/delete/role add-remove). 11 e2e; suite **126/126**; web build green; live-smoke of the full chain. ADR-0022 (P1.4b addendum).
- **P1.4c — Roles ✅ COMPLETED 2026-06-01.** New `role:manage` perm. `GET /rbac/permissions` (catalog), `GET /rbac/roles/:id`, `POST/PATCH/DELETE /rbac/roles` (`role:manage`). **System roles immutable** (edit/delete → 403); custom-role slug `^[a-z][a-z0-9_]*$` + unique (409), catalog-validated perms (400). **Perm-cache `delTenant` on edit/delete** (DB authoritative); FK-cascade unassigns on delete. Audited (`rbac.role.created/updated/deleted`). Web `/admin/roles` (create form + per-role cards, inline edit w/ domain-grouped permission picker, system read-only). Deploy note: adding a catalog perm needs a re-seed (idempotent) + cache expiry. 7 e2e; suite **133/133**; web build green; live-smoke of CRUD chain. ADR-0022 (P1.4c addendum).
- **P1.4d — Tenant settings ✅ COMPLETED 2026-06-01.** New `tenant:manage` perm. `GET/PATCH /tenant` (rename own tenant; id from auth context, slug immutable) + `PUT /branding` (method-gated so `GET /branding` stays public) updating localeDefault/logoUrl/copy with **copy-merge** upsert (theme reserved). Audited (`tenant.updated`, `tenant.branding_updated`). Web `/admin/tenant` (Identity + Branding forms; 12 copy fields). 7 e2e; suite **140/140**; web build green; live-smoke (rename + branding merge) on dev DB. ADR-0022 (P1.4d addendum).

**Scope decisions:** "Tenants" = tenant_admin editing **own** tenant (cross-tenant superadmin → later platform role); custom roles **in scope** (P1.4c); **step-up auth deferred** to a focused pass (destructive actions are permission-gated + audited).
**Depends on:** P1.1 ✅.

### P1.5 — Incidents module (first new domain after Documents) ✅ **COMPLETED 2026-06-01 (all 3 phases)**
**Why:** the dashboard's whole premise. Today "Priority Incidents" is hardcoded copy.
**Cost:** L (2 wk).
**How:** schema (`incidents`); endpoints (CRUD + transition + assign + stats); permissions; web `/incidents`; dashboard reads real data; audit on every transition; soft-delete. (ADR-0023.)
**Phased delivery** (each a complete cycle):
- **P1.5a — Backend ✅ COMPLETED 2026-06-01.** `incidents` table (severity 1-5 + CHECK, status, free-text type/region/source, summary/description, optional lat/lng `numeric`, occurred_at, reported_by/assigned_to, resolved_at, soft-delete) under RLS + migration `0009`. Contracts with the shared **status state machine** (`INCIDENT_TRANSITIONS`). 6 perms (`incident:read/create/write/assign/resolve/delete`); operator gets read/create/write/assign/resolve, auditor read, admin all. IncidentsService (create/list+filters+pagination/detail/update/**transition** state-machine/assign/softDelete/**stats**) + Controller (`incident:*`-gated; **resolve gated above write** inline). Audited (`incident.created/updated/transitioned/assigned/deleted`). 11 e2e; suite **151/151**; API lint clean; live-smoke of the full lifecycle on the dev DB. ADR-0023.
- **P1.5b — Web `/incidents` ✅ COMPLETED 2026-06-01.** List (filter bar → URL params, paginated table w/ severity+status badges, collapsible report form gated on `incident:create`) + detail (`/incidents/[id]`) with a **state-machine-aware** Actions panel (only reachable transitions; resolving hidden without `incident:resolve`), member-dropdown assign, inline edit, gated delete. New `GET /incidents/assignees` (`incident:assign`) for the assignee picker. Region/type/source datalists live in the web (jurisdiction specifics out of the API). Sidebar "Cases & Incidents" → `/incidents` for `incident:read`; middleware protects `/incidents`. +1 e2e (suite **152/152**); web typecheck + build + lint green. ADR-0023 (P1.5b addendum).
- **P1.5c — Dashboard on real data ✅ COMPLETED 2026-06-01.** New `active` list filter (status ∈ reported/triaged/in_progress, shared with stats). Dashboard hero (alert level + active/SEV counts), KPI strip (Active/SEV-1/2/3/Regions/Types), "Active by Region/Type" bars, and "Priority Incidents" (real, most-severe-first, → detail) all read `GET /incidents/stats` + `GET /incidents?active=true`; hardcoded arrays removed; fail-safe to zeros. +1 e2e (suite **153/153**); web build green; live-smoke (seeded SEV-1..4 spread → correct stats + severity-sorted list). ADR-0023 (P1.5c addendum).

**Depends on:** P1.1 ✅.
**Unblocks:** real dashboard (P1.5c), notifications (P1.6).

### P1.6 — Notifications (in-platform + email) ✅ **COMPLETED 2026-06-01 (all 3 phases)**
**Why:** the moment Incidents exist, someone must be notified. Also closes the P1.3 password-reset email gap.
**Cost:** L (1–2 wk). (ADR-0024.)
**Phased delivery** (each a complete cycle):
- **P1.6a — In-app ✅ COMPLETED 2026-06-01.** `notifications` table (tenant_id, user_id recipient, kind, title, body, link, read_at, dispatched_at) under RLS + migration `0010`. NotificationsService (self-scoped list/unread-count/mark-read/read-all + best-effort dispatch in its OWN tx, never throws). `IncidentsService` → dispatch on **assign** (→ new assignee) + **transition** (→ reporter+assignee), always excluding the actor. Self-scoped endpoints (`GET /notifications`, `/notifications/unread-count`, `POST /notifications/:id/read`, `/notifications/read-all`) — auth only, no `@Authorize`. 6 e2e; suite **159/159**; API lint clean; live-smoke wrote real rows on assign+transition. ADR-0024.
- **P1.6b — Web notification center ✅ COMPLETED 2026-06-01.** Topbar bell with unread badge (polls `/notifications/unread-count` every 30s) + dropdown of latest 8 (deep-link → mark-read + navigate) + "Mark all read". `/notifications` full page (latest 50, per-row + mark-all). Sidebar "Notifications" enabled for all; middleware protects `/notifications`. Client → server-actions (`authedApiFetch`, token stays server-side), all fail-safe. Web typecheck + build + lint green; backend unchanged → suite **159/159**. ADR-0024 (P1.6b addendum).
- **P1.6c — Email channel ✅ COMPLETED 2026-06-01.** `MailService` (Nodemailer over `MAIL_*`, best-effort; dev-logs/prod-drops when disabled) + **Mailpit** in compose (SMTP 1025, UI 8025). **Swapped the P1.3 `PasswordResetNotifier` dev-logger → `EmailResetNotifier`** — self-service reset now emails the link (closes the P1.3 gap; live-verified in Mailpit). Email on notification (`NotificationsService.create` sends + stamps `dispatched_at`, absolute `APP_BASE_URL` deep-link). `user_notification_prefs` (per-kind in-app/email on/off) under RLS + migration `0011`, applied in dispatch; self-scoped GET/PUT prefs endpoints + web toggle grid on `/notifications`. Simple HTML templates (no MJML). +5 e2e (suite **164/164**); web build green; live-smoke of both reset + incident emails. ADR-0024 (P1.6c addendum).
**Decisions:** direct best-effort dispatch (no event bus); Mailpit for dev (prod = configurable SMTP); basic prefs + simple HTML (no MJML).
**Depends on:** P1.1 ✅, P1.5 ✅.

### P1.7 — Loki + Grafana in compose ✅ **COMPLETED 2026-06-01**
**Why:** P0.3 made logs structured; this aggregates them.
**Cost:** S (1 d).
**Delivered:**
- **Loki** + **Promtail** in `infra/observability-compose.yml` (single-binary Loki, filesystem store, 7-day retention; `LOKI_PORT` 3100). `obs:up` brings up Prometheus + Grafana + Loki + Promtail.
- **API ships its own logs** via a config-gated **`pino-loki`** transport (`LOKI_URL`) — because the API runs on the HOST, a Docker scraper can't see it. Fans out to stdout **+** Loki; **unset → behaviour unchanged** (suite untouched). Best-effort (`silenceErrors`). Low-cardinality labels (`app`/`env`); `requestId`/`tenantId`/`traceId` stay in the JSON line, queried via LogQL `| json`.
- **Promtail** scrapes the `cmc-*` infra containers (postgres/redis/mailpit/…), **dropping `cmc-api`** (it self-ships → no dup).
- **Grafana**: provisioned **Loki datasource** (`cmc-loki`) + checked-in **CMC · Logs** dashboard — API log-rate-by-level, an **API logs panel filtered by `request_id`/`tenant`/search**, and an infra-container logs panel.
- **Live-validated**: 112 API log lines in Loki (with `requestId` in the line), `| json | requestId="…"` returns the exact request's line, Promtail streaming postgres/grafana/promtail (api excluded). Suite **164/164** (pino change inert when `LOKI_URL` unset). ADR-0025.
**Depends on:** P0.3 ✅.

### P1.8 — Tempo + Alertmanager ✅ **COMPLETED 2026-06-01**
**Why:** complete the observability triangle (logs / metrics / traces) before Phase-2's complexity arrives.
**Cost:** S (1 d).
**Delivered:**
- **Tempo** in `observability-compose.yml` (OTLP http 4318 / grpc 4317, query 3200, filesystem store, 7-day retention). The API exports OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` — **zero API code** (P0.6 already emits when the endpoint is set; unset → unchanged).
- **Three-signal cross-link in Grafana**: Loki→Tempo (derived field on the log line's `traceId` → trace) + Tempo→Loki (`tracesToLogsV2`, span → its logs). The P0.3/P0.6 `trace_id` correlation is now *navigable*.
- **Alertmanager** (`:9093`) + Prometheus `rule_files`/`alerting` wiring + 2 rules: `HighHttp5xxRatio` (5xx/total > 1% for 5m, `clamp_min` denom) + `ApiMetricsTargetDown` (`up==0`). Delivery receiver is a **deliberate no-op** (alerts visible in UI; paging needs a target + platform-superadmin recipient — deferred, one-block change).
- **Live-validated**: cmc-api traces in Tempo (`GET /incidents`, `POST /auth/login`; TraceQL `{resource.service.name="cmc-api"}`), both rules loaded + evaluating, Prometheus→Alertmanager discovered. ADR-0026.
**Depends on:** P0.6 ✅, P0.7 ✅.

### P1.9 — API URL versioning (`/v1`) ✅ **COMPLETED 2026-06-01**
**Why:** ToR §11.6. Cheaper to introduce now than after external consumers exist.
**Cost:** XS (½ d).
**Delivered:**
- **`app.setGlobalPrefix("v1")`** in `main.ts` — every domain route now lives under `/v1` (`/v1/auth/login`, `/v1/incidents`, …). Mirrored in `test/helpers/test-app.ts` so the suite exercises the real prefixed routing.
- **Operational endpoints deliberately EXCLUDED** (`{ path, method: GET }` for `health`, `health/ready`, `health/deep`, `metrics`): orchestrator probes (P0.8) and the Prometheus scrape (`metrics_path: /metrics`, P0.7/P1.8) hardcode those paths — versioning them would silently break the obs stack. The RED middleware's exclusion reads `req.originalUrl`, which stays unprefixed for them.
- **Web client**: a single `API_PREFIX = "/v1"` in `lib/api.ts` (the `apiFetch` chokepoint covers `authedApiFetch`, `access.ts`, `branding.ts`, every server action). NextAuth (`auth.ts`) talks to the API directly, so it carries its own `API_V1` prefix on the `/auth/login`·`/refresh`·`/logout` fetches.
- **Live-validated**: `POST /v1/auth/login`→200, old `POST /auth/login`→**404** (contract locked), `/health`+`/metrics`→200 but `/v1/health`+`/v1/metrics`→404, full authed `/v1/rbac/me`→200, and the RED label now reads `route="/v1/auth/login"` — obs continuity intact. Suite **164/164** (1 metrics route-label assertion updated). ADR-0027.
**Depends on:** —.

### P1.10 — OpenAPI generation ✅ **COMPLETED 2026-06-01**
**Why:** ToR §11.1 every endpoint defined in OpenAPI.
**Cost:** S (1–2 d).
**Delivered (P1.10a — generation + gated serving):**
- **`@nestjs/swagger@8`** + **CLI plugin** (`nest-cli.json`) auto-documents the class-validator **request DTOs** at `nest build` (18 DTO components). Document built once at boot in `main.ts` (`DocumentBuilder` + `createDocument`), paths re-prefixed `/v1`, operational endpoints (`/health*`, `/metrics`) dropped.
- **Gated `GET /v1/openapi.json`** — `OpenApiController` behind `JwtAuthGuard` + `@Authorize("tenant:manage")` (describes the full admin surface → not anonymous); `OPENAPI_ENABLED` toggle (false → 404); `@ApiExcludeController` keeps the meta-route out of the doc.
**Delivered (P1.10b — full fidelity + UI):**
- **Response bodies from the Zod contracts**: every `*Schema` in `@cmc/contracts` → component via `zod-to-json-schema` (64 schemas), `$ref`'d onto operations through a central method+path map. **Single source of truth, no drift.** 82 components total.
- **All metadata post-processed in one file** (`build-openapi-document.ts`): tags, global `bearer` security + public-op overrides (login/refresh/mfa-verify/forgot/reset/branding-GET), response refs — **zero Swagger decorators on the 11 controllers**.
- **Swagger UI** at web **`/admin/api-docs`** (gated on `tenant:manage` like all `/admin`); the page **server-fetches** the spec via the BFF (bearer attached server-side), renders swagger-ui-dist (pinned CDN) from the `spec` — browser never handles a raw token.
- **Live-validated**: 82 components (64 contract + 18 DTO); `GET /v1/incidents`→`$ref IncidentsListResponse`, `POST /v1/incidents` body→`$ref CreateIncidentDto`; global `security:[{bearer:[]}]`, public login `security:[]`; gating 401/403/200; `OPENAPI_ENABLED=false`→404. Suite **175/175**. ADR-0028.
- **Deferred (TD)**: OpenAPI 3.1 bump (emits valid 3.0.0); self-hosted Swagger UI assets (currently CDN).
**Depends on:** P1.9 ✅.

### P1.11 — Audit log hash chain (tamper-evident) ✅ **COMPLETED 2026-06-01**
**Why:** ToR §3.15. Columns exist; nothing populates them.
**Cost:** M (3–4 d).
**Delivered (P1.11a — chain):**
- `audit_log` gained `seq` (bigserial, monotonic walk order) + `sealed_at` + chain/partial-unsealed indexes (migration 0012). `prev_event_hash`/`this_hash` now populated.
- **Async sealer** (`AuditChainService`) — chosen over synchronous-at-write: rows insert on the hot path unchanged (fast, atomic, lock-free); a sealer fills hashes in `seq` order per **`(tenant, UTC day)`** chain (`this_hash = SHA256(canonical | prev)`, genesis seed, advisory-locked, idempotent). Synchronous chaining would serialise a tenant's audit-writing requests + risk cross-tx self-deadlock with the `durable` path.
- **Verifier** replays the chain, pinpoints the first broken `seq`. Gated endpoints `GET /v1/audit/chain/verify`, `POST /v1/audit/chain/seal` (`tenant:manage`).
**Delivered (P1.11b — Merkle anchoring):**
- **Daily cron** (`@nestjs/schedule`) Merkle-roots each closed sealed chain and writes the root to MinIO under **Object Lock (WORM)** — `cmc-audit-anchors` bucket created `--with-lock` by `minio-init`; `audit_chain_anchor` table (migration 0013, append-only RLS) indexes root + `last_seq` + object key/version/retain-until. `AUDIT_ANCHOR_LOCK_MODE` GOVERNANCE/COMPLIANCE, `AUDIT_ANCHOR_RETENTION_DAYS` default 10 y.
- **`verifyChain` cross-checks** the day's current Merkle root against the immutable anchor (`rootMatches`) — catches whole-day replacement; a missing past-day anchor is itself evidence. `POST /v1/audit/chain/anchor` (`tenant:manage`).
- **Live-validated**: in-place row tamper (as PG superuser, past append-only RLS) → `valid:false, brokenAtSeq`; real Object-Lock anchor (Merkle over 102 rows, versionId, retain 2036) → verify `anchored+rootMatches:true`; `mc retention info` → `GOVERNANCE, expiring in 3649 days`; locked version survives `mc rm`. Suite **188/188**. ADR-0029.
**Depends on:** —.

### P1.12 — SIEM-ready audit export (Syslog + CEF) ✅ **COMPLETED 2026-06-01**
**Why:** ToR §6.15. Even without a SIEM, the format is the contract.
**Cost:** S (1 d).
**Delivered:**
- **Export worker** (`AuditExportService`) tail-reads the audit log by durable `seq` cursor (`audit_export_cursor`, migration 0014), formats each row, ships it via a pluggable sink. `flush()` always runs (interval / `POST /v1/audit/export/flush` / test); `AUDIT_EXPORT_ENABLED` gates only the background timer. **At-least-once** — cursor advances only after the sink write + tx commit (crash re-ships, SIEM dedups on row `id`); advisory-locked.
- **Two formats** (`AUDIT_EXPORT_FORMAT`): **RFC 5424** syslog (`<PRI>1 …` facility 13, structured data) + **CEF** (`CEF:0|CMC|Platform|…`), both escaped, both carrying `id`/`seq`/tenant/actor/outcome/src/requestId/traceId.
- **Pluggable sinks** (`AUDIT_EXPORT_TRANSPORT`): `noop` (default — nothing leaks until configured), `stdout`, `file`, `tcp` (RFC 6587 octet-counting). Sink is the seam tests fake.
- Gated `GET /v1/audit/export/status` + `POST /v1/audit/export/flush` (`tenant:manage`).
- **Live-validated**: file sink exported **149** rows → 149 valid RFC 5424 lines on disk, cursor 0→149. Suite **197/197**. ADR-0030.
**Depends on:** P1.11 ✅ (exports the now-tamper-evident log).

---

## P2 — Beta (Horizon 2, ~5–7 months solo / 6 months team)

### P2.1 — NATS JetStream + outbox + relay ✅ **COMPLETED 2026-06-01**
**Why:** the event plane. Unblocks every cross-module reaction.
**Cost:** L (1–2 wk).
**Delivered (P2.1a — outbox write side):**
- **NATS JetStream** container in core compose (`-js`, volume, healthcheck). **`outbox`** table (migration 0015 + RLS like audit_log; `seq` for relay order) with the full column set. **`OutboxService.publish()`** inserts via the **ambient request tx** (ALS) → atomic with the state-change (proven: a rolling-back tx leaves NO event). Shared **`EventEnvelope`** contract + `eventSubject()` builder.
**Delivered (P2.1b — relay):**
- **`RelayService`** polls unpublished rows by `seq`, publishes to `tenant.{scope}.{aggregate}.{event}.v{version}` via a pluggable **`EventPublisher`** (real `NatsEventPublisher` dynamic-imported only when `NATS_ENABLED` — never in jest; idempotent `CMC_EVENTS` stream over `tenant.>`), stamps `published_at` in the same tx → **at-least-once**, JetStream `msgID` dedup. Advisory-locked. Gated `GET/POST /v1/events/relay/{status,flush}`.
**Delivered (P2.1c — first producer):**
- **`IncidentsService`** emits `incident.created` / `.transitioned` / `.assigned` to the outbox in the same request tx as the state change.
- **Live-validated end-to-end**: real `POST /v1/incidents` → atomic outbox write → **background relay (2 s)** auto-published → a NATS consumer received `tenant.{id}.incident.created.v1` with full payload + threaded `traceId`. Suite **212/212** (+15 event tests). ADR-0031.
**Depends on:** P0.2.
**Unblocks:** P2.2, P2.3, P2.4.

### P2.2 — Audit-projection-to-ClickHouse consumer ✅ **COMPLETED 2026-06-01**
**Why:** offload analytical queries from OLTP; long-term audit retention.
**Cost:** L (1 wk after CH up).
**Delivered:**
- **Cursor-tail ETL** (not the event bus — audit is a firehose): `AuditProjectionService.flush()` reads `audit_log` past a `projection_cursors` position in `seq` order, bulk-inserts into `cmc.audit_events`, advances the cursor (advisory-locked, at-least-once). Reuses the SIEM cursor pattern (ADR-0030) + CH client (ADR-0033).
- **CH schema** (02-audit.sql): `audit_events` (MergeTree, Nullable tenant/actor) + `audit_daily_stats` (SummingMergeTree) + MV (daily counts by action/outcome). Generic `projection_cursors(consumer,last_seq)` table (migration 0017).
- Gated `GET /v1/audit/projection/status` + `POST /v1/audit/projection/flush` (`tenant:manage`); background interval gated on ClickHouse reachable.
- **Live-validated**: 160 Postgres audit rows → 160 CH `audit_events` (exact); `audit_daily_stats` MV → `user.login 88, incident.created 15, …`. Suite **223/223** (+4 tests). ADR-0034.
**Depends on:** P2.1 ✅, P2.5 ✅.

### P2.3 — WebSocket gateway ✅ **COMPLETED 2026-06-02**
**Why:** Realtime plane.
**Cost:** L (1–2 wk).
**Decision (P2.3a):** built **in `apps/api`**, not a separate `apps/realtime` app — reuses the global `JwtService`, P1.1 `RbacService` (P2.3b), the NATS connection, config, and the test harness; the gateway is kept modular so it can be extracted to its own app when WS load justifies isolating it. Native `ws` (standard browser WebSocket, no client lib), attached to the existing HTTP server's `upgrade` event (no Nest WS adapter → zero blast radius on the suite).
**Delivered (P2.3a — gateway + auth + subscriptions):**
- `RealtimeModule` (@Global): a `noServer` `ws` server hooked to the HTTP `upgrade` event at bootstrap (gated `REALTIME_ENABLED`). **Auth before handshake** — `WsAuthService` verifies the access JWT (HS256+issuer, like `TenantContextMiddleware`) + confirms the session is active; failed auth → plain `401`, no `101`. Token via the `cmc-bearer` subprotocol (preferred) or `?access_token=` fallback.
- JSON protocol (`@cmc/contracts/realtime`): `subscribe`/`unsubscribe`/`ping` ⇄ `welcome`/`subscribed`/`unsubscribed`/`event`/`pong`/`error`. **Tenant-isolated subscriptions** — a pattern must be literally `tenant.<ownTenantId>.…` (cross-tenant / `tenant.*` / `system` rejected). In-memory `RealtimeRegistryService` (NATS-style subject matcher) + `broadcast()` fan-out seam + `GET /v1/realtime/status` (`tenant:manage`).
- **Validated**: suite **235/235** (30 suites; +12 incl. pure matcher + live sockets), eslint/tsc/build clean; live smoke (booted API, real WS) — subprotocol auth → welcome → own-tenant subscribe accepted / wildcard rejected → ping/pong → status.
**Delivered (P2.3b — NATS fan-out + RBAC):**
- `RealtimeFanoutSubscriber`: **ephemeral** JetStream consumer (per-process — realtime is fan-out, not a work queue, so every instance sees every event; a shared durable would load-balance and starve sockets), `DeliverPolicy.New` (live, not history), filter `tenant.>` → `registry.broadcast()` to matching sockets; best-effort ack; `nats` dynamic-imported.
- **Per-subscription RBAC** (fail-closed): a `subject → permission` map (`incident → incident:read`; unmapped / wildcard-aggregate → rejected) checked against permissions resolved **once at connect** (`RbacService.resolvePermissions`). A role-less user is rejected even within its own tenant.
- **Validated**: suite **237/237** (30 suites; +2 RBAC tests, 14 realtime total), eslint/tsc/build clean. **Full-chain live smoke** (NATS on): `POST /v1/incidents` → outbox → relay → NATS → ephemeral fan-out → `broadcast()` → subscribed WS socket received `tenant.<id>.incident.created.v1`. ADR-0035.
**Deferred (follow-on):** browser client hook/UI (pairs with P2.6 dashboard); **Redis pub/sub** cross-instance fan-out (multi-instance scale); mid-connection RBAC-revocation (bounded by session TTL today).
**Depends on:** P2.1 ✅, P1.1 ✅.

### P2.4 — Notifications consumed from events ✅ **COMPLETED 2026-06-01**
**Why:** decouple incident-triggers-notification from a direct service call.
**Cost:** M (3–5 d) refactor of P1.6.
**Delivered:**
- **First durable JetStream consumer.** `IncidentNotificationsConsumer.handle()` (pure, testable) reacts to `incident.assigned`/`.transitioned`, **claims** the event in a reusable dedup ledger (`consumed_events`, migration 0016), loads the incident tenant-scoped, dispatches the notification. `IncidentNotificationsSubscriber` is the NATS plumbing (durable consumer, **`DeliverPolicy.New`** so no history replay, explicit-ack/nak, `nats` dynamic-imported → never in jest).
- **Zero-regression decoupling**: `IncidentsService` dispatches inline ONLY when `NATS_ENABLED` is false; with NATS on, the consumer is the sole path. Exactly one fires — existing P1.6 tests stay green.
- **Live-validated**: real assign with NATS on → inline skipped → outbox → relay → JetStream → consumer → assignee got exactly one `incident.assigned` notification; idempotent (dedup) + forward-only. Suite **216/216** (+4 consumer tests). ADR-0032.
**Depends on:** P2.1 ✅.

### P2.5 — ClickHouse single-shard ✅ **COMPLETED 2026-06-01**
**Why:** analytical store.
**Cost:** M (1 wk to deploy + first MV).
**Delivered:**
- **ClickHouse** container (HTTP 8123 only — native 9000 collides w/ MinIO; volume, healthcheck), schema applied from mounted init SQL: `cmc.incident_events` (MergeTree raw stream) + `cmc.incident_daily_stats_by_region` (SummingMergeTree) + `incident_daily_stats_mv` MV (rolls up `created` events). `@clickhouse/client`, gated lazy client (dynamic-imported → never in jest).
- **Second durable consumer** (P2.5b) reusing the P2.4 pattern: `IncidentProjectionConsumer.handle()` inserts incident events into CH (idempotent via `consumed_events`, buckets by incident occurrence time); subscriber uses **`DeliverPolicy.All`** (projections backfill) gated on NATS+ClickHouse.
- **Live-validated**: real `POST /v1/incidents` → relay → NATS → projection → `incident_events` row → MV `(2026-06-01, Sughd, 1)`. Suite **219/219** (+3 projection tests). ADR-0033.
**Depends on:** P2.1 ✅.
**Unblocks:** P2.2, P2.6.

### P2.6 — Dashboard data — CH-backed metrics ✅ **COMPLETED 2026-06-02**
**Why:** add the historical analytics the OLTP snapshot can't serve (the snapshot widgets already went real in P1.5c).
**Cost:** M (3–5 d).
**Delivered:**
- `DashboardAnalyticsService` (in `AnalyticsModule`) reads the P2.5 daily-by-region MV → a **daily incident trend**; **tenant-scoped** (CH has no RLS → `WHERE tenant_id`, UUID-asserted), pure `buildDailyTrend` gap-fills to a continuous window (clamped 1–90), **graceful** (`source: unavailable`) when CH is off. `GET /v1/analytics/dashboard` (`incident:read`) — under `/v1/analytics`, not `/v1/metrics` (the latter is the Prometheus scrape, P0.7).
- **Web**: dashboard server component fetches it; new `TrendChart` bar widget; degrades to "analytics unavailable".
- **Validated**: suite **244/244** (31 suites; +7), API+web `tsc`/lint/build clean, no migration. **Live smoke** (real CH): `source=clickhouse`, 14 gap-filled points; create incident → today's bucket `2 → 3`. ADR-0036.
**Deferred:** more CH widgets (by-region trend, audit activity, MTTR); realtime dashboard refresh via P2.3.
**Depends on:** P2.5 ✅.

### P2.7 — GIS substrate (schemas + RLS + endpoints) ✅ **COMPLETED 2026-06-02**
**Why:** the platform's spatial commitment. Phase-2 entry into the GIS plane.
**Cost:** L (2 wk).
**Note:** the dev Postgres image already ships **PostGIS** (`cmc/postgres:16-postgis-pgvector`) — no infra switch; the migration just `CREATE EXTENSION IF NOT EXISTS postgis` (idempotent, runs as the migration owner so the test DB is self-sufficient).
**Delivered (P2.7a — schema + migration + contracts + perms):**
- `gis_layers` (name, kind, style/schema jsonb, source_uri, is_public, created_by, soft-delete) + `gis_features` (`geometry geometry(GeometryZ, 4326)` via a Drizzle `customType`, properties jsonb, soft-delete). Migration **0018**: extension + tables + **GIST** index on geometry + tenant/layer btree indexes + **RLS** (two-GUC) on both. Applied to dev + `cmc_test`; geometry round-trip verified (`ST_GeomFromGeoJSON`/`ST_AsGeoJSON`).
- Contracts `@cmc/contracts/gis` (GeoJSON geometry, layer/feature CRUD + bbox query + list responses). Permissions `gis:layer:read`/`gis:layer:edit`/`gis:feature:write` in the catalog + granted to operator (read + feature:write) / auditor (read) / tenant_admin (`*`).
- **Validated**: suite **244/244** (31 suites), API `tsc` + db build clean, no new failures (exit-1 = pre-existing OTEL post-teardown log noise).
**Delivered (P2.7b — service + endpoints):**
- `GisService` + `GisController` under `/v1/gis`: layer CRUD (`gis_layer:read`/`:edit`) + feature CRUD (`gis_feature:write`) — geometry written via `ST_SetSRID(ST_GeomFromGeoJSON,4326)`, read via `ST_AsGeoJSON`; **bbox list** filters with `&& ST_MakeEnvelope` (GIST-indexed); GeoJSON structurally Zod-validated → clean 400; tenant-scoped via RLS; audited; soft-delete.
- **RBAC fix**: keys are `${domain}:${action}` split on ONE colon, so the sub-resource lives in the domain (`gis_layer`/`gis_feature`) — a `gis:layer:edit` form mis-parsed + dropped the grant.
- **Validated**: suite **250/250** (32 suites; +6 GIS), API `tsc`/`eslint`/`nest build` clean. **Live smoke** (booted API, real PostGIS): layer → feature (`Point [68.78,38.56]` round-trips exactly) → bbox near=1/far=0 → featureCount=1. ADR-0037.
**Deferred:** GIS domain events / realtime map updates; properties-schema enforcement; import/export (GeoPackage/Shp).
**Depends on:** P1.1 ✅.
**Unblocks:** P2.8 (tile server), P2.9 (MapLibre).

### P2.8 — Custom NestJS tile server ✅ **COMPLETED 2026-06-02**
**Why:** vector tiles per-tenant.
**Cost:** M (1 wk).
**Delivered:**
- `GET /v1/gis/tiles/:layerId/:z/:x/:y.mvt` (`gis_layer:read`) — `GisService.tile()` renders MVT in-DB with `ST_AsMVT`; the tile envelope (`ST_TileEnvelope`, 3857) filters via **GIST** (`geometry && ST_Transform(envelope,4326)`) then `ST_AsMVTGeom` to 3857. Binary `@Res` (`application/vnd.mapbox-vector-tile`), `Cache-Control: private, max-age=60`, **204** for empty tiles, **400** for out-of-range z/x/y. RLS-scoped (unknown/cross-tenant layer → empty tile).
- **Validated**: suite **254/254** (32 suites; +4 tile tests), `tsc`/`eslint`/`nest build` clean, no migration. **Live smoke**: world `0/0/0.mvt` → 200 / 86-byte MVT (`features` layer); western `1/0/0` → 204; `2/9/0` → 400. ADR-0038.
**Deferred:** tile cache/CDN + signed-URL variant; multi-layer combined tiles.
**Depends on:** P2.7 ✅.
**Unblocks:** P2.9 (MapLibre).

### P2.9 — MapLibre frontend ✅ **COMPLETED 2026-06-02**
**Why:** users see the map.
**Cost:** L (1–2 wk).
**Decision (tile auth):** tiles go through a **BFF proxy route** (`app/api/gis/tiles/[layerId]/[z]/[x]/[y]/route.ts`) — MapLibre fetches same-origin (session cookie rides along), the handler attaches the API bearer server-side. The access token never reaches the browser (same posture as `authedApiFetch`).
**Delivered (P2.9a — map + tiles):**
- `maplibre-gl@5`; `/map` server page (`authedApiFetch /gis/layers` → `<MapView>`); client `MapView` dynamic-imports MapLibre in an effect (never SSR-loaded), renders a vector source per layer → the tile proxy, as fill+line+circle (any geometry). Basemap configurable via `NEXT_PUBLIC_MAP_STYLE_URL` (default: minimal self-contained style; set to demotiles/self-hosted for imagery). Centered on Tajikistan. Sidebar "GIS Map" nav enabled → `/map`.
- **Validated**: web `tsc` + production build clean (`/map` route compiles); BFF proxy live-smoked — unauth tile → **401** (server-side gate), `/map` reachable. *(Visual map rendering needs a browser — not machine-verifiable here.)*
**Delivered (P2.9b — toggle + inspector):** per-layer visibility toggle panel (`setLayoutProperty`), click → `queryRenderedFeatures` → right-hand **feature inspector** (layer / geometry type / properties), cursor feedback. Web `tsc` + build clean. ADR-0039.
**Caveat:** visual map rendering is **not machine-verified** (no browser here) — verified: build/types + BFF proxy auth gate (unauth → 401). A human should confirm the map draws after login.
**Deferred:** on-map editing (draw/move), clustering/heatmap, a shipped basemap, realtime layer updates (P2.3 hook).
**Depends on:** P2.8 ✅.

### P2.10 — Cases module ✅ **COMPLETED 2026-06-02 (backend MVP)**
**Why:** the second domain user-of-the-platform module.
**Cost:** L (2 wk).
**Delivered (backend, modelled on incidents P1.5):**
- `cases` (title, type, priority 1..5+CHECK, status state-machine, assignee, `due_at` SLA, soft-delete) + `case_activity` timeline; migration 0019 + **RLS** on both. `CasesService` + `/v1/cases` (CRUD, transition w/ resolve-gate, assign, **comment + activity timeline**, stats); tenant-scoped, audited, **outbox events** (`case.created/transitioned/assigned`). Perms `case:read/create/write/assign/resolve/delete`.
- **Validated**: suite **261/261** (33 suites; +7 cases), `tsc`/`eslint`/`nest build` clean. **Live smoke**: create → in_progress → comment → activity `created/status_changed/comment` → stats `openTotal:1`. ADR-0040.
**Deferred:** config-driven case types, assignment policies, **SLA escalation cron** (→ Temporal P3.1; `due_at` stored), linked artifacts (incident/document/gis_feature), per-tenant `case_number`, **web UI** (dashboard "Cases Open" stays hardcoded until a cases UI lands), case events consumer.
**Depends on:** P1.1 ✅, P1.5 ✅, P2.7 ✅.

### P2.11 — Postgres `tsvector` search ✅ **COMPLETED 2026-06-02**
**Why:** OpenSearch is Phase-3; this is the interim.
**Cost:** M (3–5 d).
**Delivered:**
- **GIN `to_tsvector('simple', …)` expression indexes** (migration 0020, via drizzle schema) on incidents (summary/description/type/region), cases (title/description/type), documents (name/description).
- `GET /v1/search?q=` (`SearchService` + `SearchController`, JWT-only): resolves caller perms → fans out per readable domain (`incident:read`/`case:read`/`document:read`), each RLS-scoped `websearch_to_tsquery('simple')` + `ts_rank`, merged by score → uniform `SearchResult` (type/id/title/snippet/score). User `q` always parameterised.
- **Validated**: suite **267/267** (34 suites; +6 search), `tsc`/`eslint`/`nest build` clean. **Live smoke**: `flood` → 4 ranked cross-domain results; `zarafshan` → 1 incident. ADR-0041.
**Deferred:** stemming / per-language configs / fuzzy (→ OpenSearch P3), `ts_headline` highlight snippets, global (vs per-domain-top-N) ranking, more domains, a web search UI.

### P2.12 — Multipart upload ✅ **COMPLETED 2026-06-02**
**Why:** large-file handling. ToR §15.8.
**Cost:** M (1 wk).
**Decision:** **API-orchestrated S3 multipart** (user-confirmed) instead of a tus.io protocol server — fits the existing presigned-URL/MinIO/documents stack + is testable; full tus.io left as a future alternative.
**Delivered:**
- `StorageService`: create/presign-part/complete/abort multipart. `DocumentsService` + `/v1/documents/multipart/init` → presigned `UploadPart` URLs per part (count from `sizeBytes/partSize`), client PUTs parts directly to MinIO (retry = resumable), `/:id/multipart/complete` (assemble → ready + size via HEAD) + `/:id/multipart/abort` (status failed). `uploadId` persisted server-side (`documents.metadata`), never trusted from the client; `document:write`, RLS, ownership-checked. `DOCUMENTS_MULTIPART_PART_SIZE` config.
- **Validated**: suite **271/271** (35 suites; +4), `tsc`/`eslint`/`nest build` clean, no migration. **Live smoke + e2e** (real MinIO): >5 MiB two-part upload assembles + downloads byte-for-byte; abort works. ADR-0042.
**Deferred:** tus.io protocol; server `ListParts` (resume re-derivation); per-part checksum; abandoned-upload GC; web UI.
**Depends on:** —.

### P2.13 — Preview generation worker ✅ **DONE (2026-06-02)**
**Why:** every file UI gets ten times better with thumbnails.
**Cost:** L (1–2 wk).
**Delivered (P2.13a — queue seam + image previews + enqueue):**
- `bullmq` + `sharp`. **Gated-lazy queue seam** `PREVIEW_QUEUE` (Noop / BullMQ, dynamic-imported → never in jest unless `PREVIEWS_ENABLED`). `PreviewService.enqueue()` wired into finalize + multipart-complete (best-effort, never blocks the upload). `generatePreview()`: **image → WebP via sharp** (`StorageService.getObjectBytes`/`putObject`, `previews/<key>.webp`), writes `documents.metadata.previews`; PDF/video/audio → skipped with a log (need poppler/ffmpeg). `PREVIEWS_ENABLED` + `PREVIEW_MAX_DIM` config.
**Delivered (P2.13b — worker + read path):**
- **`PreviewWorker`** (gated `OnModuleInit`, dynamic-imports `bullmq` Worker + `ioredis`) consumes `cmc-previews` → `generatePreview(tenantId, documentId)`. Job payload `PreviewJob { tenantId, documentId }` (worker has no request context). `GET /v1/documents/:id/preview-url` (`document:read`) → signed `image/webp` GET, **404** when none. Document contract gains **`previewKinds: string[]`** (from `metadata.previews`). OpenAPI entry added.
- **Validated**: suite **274/274** (36 suites; +1), `tsc`/`eslint`/`nest build` clean. e2e (real MinIO): finalize enqueues (faked queue) + a PNG renders a real WebP (RIFF) recorded in metadata, surfaced via `previewKinds` + `preview-url` (signed URL fetches WEBP); `preview-url` 404 when none; non-image skipped. **Live smoke** (`PREVIEWS_ENABLED` + Redis): real BullMQ worker renders the preview → `previewKinds:["image"]` → `preview-url` serves valid WEBP. No migration (uses `documents.metadata`). ADR-0043.
**Gotcha:** BullMQ forbids `:` in queue names (Redis key separator) and only throws when the real queue is built — invisible to the queue-faked suite, caught by the live smoke; queue name is `cmc-previews`.
**Deferred:** PDF/video/audio previews (poppler/ffmpeg in the runtime image); preview backfill janitor; web UI wired to `preview-url`.
**Depends on:** P0.2 (Redis for BullMQ).

### P2.14 — Vault dev mode + first secret migration ✅ **DONE (2026-06-02)**
**Why:** stop bringing secrets in `.env` files into prod.
**Cost:** M (1 wk to integrate; ongoing for additional secrets).
**Delivered:**
- **Vault dev mode** + a `vault-init` one-shot in `infra/docker-compose.yml` (`hashicorp/vault:1.15.6`, in-memory/auto-unsealed/root-token — dev only; seeds `secret/cmc/api` with `MFA_ENC_KEY`).
- **In-process gated loader** `src/config/vault-secrets.ts`: when `VAULT_ENABLED`, KV v2 read (`/v1/{mount}/data/{path}`, `X-Vault-Token`) → overlays keys into `process.env` **before** validation; Vault wins over `.env`; logs key names only. Off by default → pure-env no-op (dev/test/CI need no Vault). `env`+`fetch` are params → hermetically testable. `VAULT_*` config added; **MFA_ENC_KEY is the first migrated secret** (`SecretBoxService` reads it via `config.get` unchanged).
- **Gotcha → structural fix:** `ConfigModule.forRoot({ validate })` validates `process.env` at module-IMPORT time, so `main.ts` now imports `AppModule` (+ openapi helpers) **dynamically** inside `bootstrap()`, after `loadVaultSecrets()` — else the overlay lands too late. Caught by the live smoke (the hermetic test can't see it).
- **Validated**: suite **279/279** (37 suites; +5), `tsc`/`eslint`/`nest build` clean, no migration. e2e `vault-secrets` (5, hermetic faked fetch+env): disabled no-op; KV v2 overlay (URL+token, Vault-over-env); no-token throw; non-OK throw; empty-secret tolerated. **Live smoke** (real Vault dev container): with an invalid `MFA_ENC_KEY` in env — Vault off → boot fails (`32 bytes`); Vault on → `loaded 1 secret(s) … MFA_ENC_KEY`, app boots, `/health` 200. ADR-0044.
**Deferred (the prod vision):** dynamic **database-secrets engine** (short-lived `cmc_app` creds + lease renewal + per-pod lease), **AppRole/k8s auth** (not a static token), **Vault Agent sidecar** (templated files), runtime secret refresh, multi-path secrets.
**Depends on:** —.

---

## P3 — Production (Horizon 3, ~9–12 months solo / 6 months team)

### P3.1 — Temporal self-hosted + first workflow ✅ **DONE (2026-06-02)**
**Cost:** L (2 wk).
**Why:** durable, code-defined workflows. Replaces the cron-based SLA timers from P2.10.
**Decisions (confirmed):** worker runs **gated in-process in apps/api** (not a separate process); first workflow is the **case SLA-escalation timer**.
**Delivered (P3.1a — substrate + workflow):**
- `@temporalio/{client,worker,workflow,activity}`. Dev compose: **Temporal** (`auto-setup`, schema in the existing Postgres) on :7233 + **Web UI** on :8233. `TEMPORAL_*` config.
- **Gated client seam** `TEMPORAL_CLIENT` (Noop / Real, dynamic-imports `@temporalio/client` → never in jest unless `TEMPORAL_ENABLED`). **Gated in-process worker** (`OnModuleInit`, dynamic-imports `@temporalio/worker`, bundles `./workflows`, runs activities built from injected services). **`caseSlaWorkflow`** (determinism-safe: sleep-until-`due_at` → escalate-if-still-open; cancellable) + activities (`loadCaseStatus`, idempotent `escalateCase` → `sla_breached` case_activity row + `case.sla_breached` outbox event). **`CaseSlaScheduler`** surface (`schedule`/`cancel`, one-per-case workflow id). Added `sla_breached` to `CASE_ACTIVITY_KINDS` (no migration — `kind` is unconstrained varchar).
**Delivered (P3.1b — lifecycle wiring):**
- `CaseSlaScheduler` wired into **CasesService**: **create** with `due_at` → schedule; **update** when `due_at` changes → schedule (open) / cancel (cleared or not open); **transition** → cancel on leaving the open set, reschedule on reopen. Best-effort (a Temporal failure never breaks case CRUD). Reschedule uses `workflowIdConflictPolicy: TERMINATE_EXISTING` (atomic replace, no race).
- **Validated**: suite **288/288** (38 suites; +9 total for P3.1), `tsc`/`eslint`/`nest build` clean. e2e `temporal` (9, faked client): gating/noop + scheduler→client + **lifecycle** (create-with-`due_at` schedules, create-without doesn't, terminal transition cancels, update sets/clears). **Live smoke through the API** (real Temporal): a case created with a 4 s `due_at` auto-escalates (`sla_breached` activity + `case.sla_breached` outbox); a case resolved before its 5 s `due_at` is not escalated. ADR-0045.
**Deferred:** separate `apps/worker` process + worker scaling; production Temporal (HA/mTLS/archival); multi-stage SLAs (warn→breach→tiers); web surface for workflow state. → incident-response workflow (P3.2), visual builder (P3.8).
**Depends on:** P2.1 (events to trigger workflows).

### P3.2 — Incident-response workflow ✅ **DONE (2026-06-02)**
Workflow: severity-declared → assemble responders (by region + role) → page on-call → create war-room thread → SLA timers → reminders → post-mortem template generation.
**Decisions (confirmed):** scope = **notify → ack-SLA → remind → escalate** (war-room/external-paging/post-mortem deferred — no chat/paging modules yet); **auto-start for severity ≤ threshold** (default SEV-1/2); responders = **assignee + reporter**, escalate to **`incident:resolve` holders** (no region/role responder model exists, so "page on-call" = notify via P1.6).
**Delivered (P3.2a — workflow + scheduler + helpers):**
- **`incidentResponseWorkflow`** (reuses the P3.1 Temporal substrate): page responders → loop sleeping a reminder interval at a time up to the ack SLA, reminding while the incident stays `reported`; escalate if still unacknowledged at the deadline. Cancellable; per-step status re-check. Activities: `loadIncidentStatus`, `notifyResponders` (assignee+reporter, page/reminder), idempotent `escalateIncident` (→ `incident:resolve` holders + `incident.escalated` outbox event).
- **`IncidentResponseScheduler`** (`onCreated` severity-gated, `onSeverityChanged`, `cancel`; one-per-incident workflow id; best-effort). Worker now hosts **both** activity sets. New helpers: **`RbacService.usersWithPermission(domain,action)`** (reverse lookup), **`NotificationsService.notifyUsers(...)`** (public fan-out seam), notification kinds `incident.response`/`incident.escalated`, `INCIDENT_OPEN_STATUSES`. Config: `INCIDENT_RESPONSE_SEVERITY_THRESHOLD`, `INCIDENT_ACK_SLA_SEC`, `INCIDENT_REMINDER_INTERVAL_SEC`. `NotificationsModule` made `@Global`.
- **Validated**: suite **292/292** (38 suites; +4), `tsc`/`eslint`/`nest build` clean. e2e `temporal` (13, faked client): incident scheduler (severe→start / low-sev→noop / cancel) + `usersWithPermission` finds `incident:resolve` holders. Worker boots + bundles **both** workflows (1.41 MB). No migration (`incident.escalated` is a new outbox event verb; notification kinds are additive).
**Delivered (P3.2b — IncidentsService wiring):**
- `IncidentResponseScheduler` wired into **IncidentsService**: **create** → `onCreated` (start iff severity ≤ threshold); **update** on severity change → `onSeverityChanged` (open-aware (re)start/cancel); **transition** → cancel on leaving the open set. Best-effort.
- **Validated**: suite **295/295** (38 suites; +7 total for P3.2), `tsc`/`eslint`/`nest build` clean. e2e `temporal` (16): + IncidentsService lifecycle (severe create starts, low-sev doesn't, terminal transition cancels). **Live smoke through the API** (real Temporal, 6 s ack-SLA / 3 s reminder): a SEV-1 left unacknowledged → 2× `incident.response` (page+reminder) + 1× `incident.escalated`; a SEV-1 acknowledged (triaged) before the deadline → 0 escalations (workflow self-stops). ADR-0046.
**Deferred (the plan's fuller vision):** responder model by region+role / on-call rotations; external paging (PagerDuty/Opsgenie); war-room thread (needs a chat module); post-mortem template generation on resolve; multi-tier escalation policies; explicit ack action.
**Depends on:** P3.1, P1.6.

### P3.3 — Folder model + permission inheritance for files ✅ **DONE (2026-06-02)**
ToR §9.1, §9.2. `ltree` paths. Inheritance algorithm in service + decision cache.
**Decisions (confirmed):** folder tree first (defer ACL inheritance to P3.3b); store the tree as an **ltree materialised path**.
**Delivered (P3.3a — folder tree + document filing):**
- `folders` table: **ltree path** of id-labels (root→self), GiST-indexed, `parent_id` alongside, RLS (two-GUC), soft-delete. `documents.folder_id` (nullable, `ON DELETE SET NULL`). Migration 0021 (`CREATE EXTENSION ltree` + GiST + RLS). ltree custom drizzle type; self-FK via `AnyPgColumn`.
- **FoldersService/Controller** (`folder:read/write/delete`): create (path computed app-side), rename (name only — id-labels mean no repath), **move** (validate parent, reject cycle `newParent <@ self`, **repath subtree in one statement**, reparent), tree (path-ordered), soft-delete subtree + **unfile** its documents. **Document↔folder linking**: `folderId` on upload-init/multipart-init (validated), `GET /documents?folderId=`, `POST /documents/:id/move`, `folderId` on the `Document` contract. `folder:*` perms in the catalog + seeded (operator/auditor; tenant_admin via `*`).
- **Validated**: suite **304/304** (39 suites; +9), `tsc`/`eslint`/`nest build` clean. e2e `folders` (real Postgres+RLS+ltree): create/depth, tree order, rename-no-repath, move+subtree-repath, cycle→400, delete-subtree+unfile, upload-init filing + unknown-folder 400, `?folderId=` filter + doc move/unfile, RBAC 403. **Gotcha:** `subpath(path, nlevel(oldPath))` errors on the moved folder's own row (offset==nlevel) → repath uses a `CASE` for the self row.
**Delivered (P3.3b — permission inheritance):**
- **Restricted subtrees** (`folders.restricted`): a folder + descendants visible only to grant-holders + `folder:manage` admins + the creator; unrestricted folders keep tenant-wide RBAC. **`folder_grants`** (polymorphic user/role subject, read/write access, RLS) inherit **down** the subtree → access(F) ⇔ a grant/creation on any ancestor-or-self (`F.path <@ grantPath`). **`FolderAccessService`** resolves a per-user context (admin + RBAC fallbacks + read/write grant paths + restricted paths) with a **Redis decision cache** (`cmc:folderacc:*`, 60 s, invalidated tenant-wide on restrict/grant/structure changes).
- **Enforcement**: folders tree filters / getOne 404 / write-gated create-move-rename-delete; documents list correlated-ltree filter + getOne/download/preview 404 + filing requires write on target. `PATCH /folders/:id/restrict` + `POST|GET|DELETE /folders/:id/grants` gated on new **`folder:manage`** perm; audited.
- **Validated**: suite **310/310** (40 suites; +6), `tsc`/`eslint`/`nest build` clean, migration 0022. e2e `folder-access`: restricted hidden + admin bypass; user grant; role grant (all members); read≠write; documents filtered + 404; creator bypass. ADR-0048.
**Deferred:** allow/deny ACL (only widening grants); access-filtering of `/v1/search` results; per-subject (vs tenant-wide) cache invalidation; grant web UI.
**Depends on:** P1.1.

### P3.4 — Document versioning ✅ **DONE (2026-06-02)**
`document_versions` child table. Storage-side copy-on-write (object dedup by content hash where MinIO supports it).
**Decisions (confirmed):** explicit new-version upload; capture content_hash, separate objects (defer byte-dedup).
**Delivered:**
- **`document_versions`** (immutable per-version row: version_no, storage_key, size, etag, `content_hash`, mime, uploaded_by; RLS) + **`documents.current_version_no`** with the row **denormalising** the current version's bytes (download/list/preview unchanged). v1 created at finalize/complete; **existing docs backfilled** to v1 (migration 0023).
- **New-version upload**: `POST /documents/:id/versions` (presigned PUT to `…/vN`, pending stashed server-side in metadata) → `…/versions/finalize` (HEAD → record → repoint current). **`GET /documents/:id/versions`**, **`…/versions/:n/download-url`** (any version's bytes), **`…/versions/:n/restore`** (rollback — repoint, no new bytes). Best-effort **SHA-256** at finalize (size-capped `DOCUMENTS_HASH_MAX_BYTES`, default 50 MiB). Version reads inherit folder access (P3.3b); writes require folder write; audited.
- **Validated**: suite **314/314** (41 suites; +4), `tsc`/`eslint`/`nest build` clean, migration 0023. e2e `documents-versions` (real MinIO): v1+hash; new version bumps current + old versions downloadable + distinct hashes; restore rolls back (no new row); unknown version 404.
- **ADR-0049**.
**Deferred:** byte-level dedup (shared objects + refcount GC); hash for over-cap files; orphaned-version-object janitor; diff/compare + web UI.
**Depends on:** P3.3.

### P3.5 — Retention policies + legal hold ✅ **DONE (2026-06-02)**
Per-folder + per-document rules. Nightly retention sweeper. Legal-hold flag suspends deletion.
**Decisions (confirmed):** per-folder rule inherited (ltree) + per-doc override; soft-delete on expiry; @nestjs/schedule daily cron (gated + manual flush).
**Delivered:**
- **`folders.retention_days`** (inherited down) + **`documents.retention_days`** (override) + **`documents.legal_hold`**; migration 0024. Effective retention = COALESCE(doc override, nearest ancestor folder policy via ltree `<@`); expiry = `updated_at + days`; null/legal-hold = kept.
- **`RetentionService`**: `@Cron(EVERY_DAY_AT_2AM)` gated by `RETENTION_ENABLED` (off by default — no surprise auto-delete) + `sweep(tenantId?)` (privileged CTE soft-delete, per-tenant audit summary, sealer-chained). **`POST /documents/retention/sweep`** (`document:delete`, tenant-scoped, always runs). Endpoints: `PATCH /folders/:id/retention` (`folder:write`), `POST /documents/:id/retention` + `…/legal-hold` (`document:write`). `softDelete` blocked under legal hold (403). Contracts gain `retentionDays` (folder+doc) + `legalHold` (doc).
- **Validated**: suite **320/320** (42 suites; +6), `tsc`/`eslint`/`nest build` clean, migration 0024. e2e `documents-retention`: inherited policy soft-deletes expired; no-policy kept; per-doc override wins; legal hold suspends sweep + blocks delete (then lift→204); fields surfaced via API.
- **ADR-0050**.
**Deferred:** hard-purge job (reclaim object bytes); folder-level legal hold + dedicated compliance perm; explicit per-doc expiry date (vs `updated_at` anchor); retention for non-document domains.
**Depends on:** P3.4.

### P3.6 — OpenSearch + permission-aware indexing ✅ **DONE (2026-06-02)**
Phase-3 search. Split a/b: **a** = the indexing substrate (gated seam + best-effort document indexer); **b** = the permission-aware search query + endpoint (post-filter via folder access). ADR-0051.
**Decisions (confirmed):** documents only (incidents/cases stay on Postgres FTS for now); direct best-effort indexing from `DocumentsService` (no outbox/queue); search results post-filtered through `FolderAccessService` (P3.6b).

#### P3.6a — OpenSearch substrate + document indexer ✅ **DONE (2026-06-02)**
- **Gated-lazy seam** (`modules/search/search-index.ts`): `SEARCH_INDEX` token + `SearchIndex` interface (`ensureIndex`/`indexDocument`/`deleteDocument`/`search`/`ping`/`close`) + `NoopSearchIndex` + `createSearchIndex` factory that dynamic-imports `RealSearchIndex` (`@opensearch-project/opensearch`) only when `OPENSEARCH_ENABLED` — so the driver never enters jest. Mirrors the ClickHouse seam (P2.5). `SearchIndexBootstrap` (OnModuleInit) `ensureIndex`es the `cmc-documents` index (keyword/text/date mapping) at boot when active.
- **Indexer**: `DocumentsService` injects `SEARCH_INDEX`; best-effort `indexDoc`/`unindexDoc` (try/catch → warn, never block the write path) called on finalize, multipart-complete, version-finalize, version-restore, move (index) + soft-delete (unindex). **`reindex()`** (`POST /v1/documents/reindex`, `document:write`) backfills all ready, non-deleted docs in the tenant (count returned) — for enabling the index after data exists. `ReindexResponse` contract + OpenAPI entry.
- **Infra**: `opensearch` compose service (2.17.1 single-node, security plugin disabled — DEV ONLY, memlock, `_cluster/health` healthcheck) + `opensearch_data` volume. Config: `OPENSEARCH_ENABLED` (default off), `OPENSEARCH_URL`, `OPENSEARCH_INDEX_PREFIX`.
- **Validated**: suite **325/325** (43 suites; +5), `tsc`/`eslint`/`nest build` clean. e2e `documents-search-index` (faked seam): indexes on finalize, unindexes on delete, re-indexes on move (folderId change), reindex reports count + skips non-ready, **indexing failures do not break the write path**. **Live smoke** (real OpenSearch 2.17.1): ensureIndex idempotent, ping, index → search by name + description, tenant isolation, delete + 404-swallow.
- **Deferred → P3.6b**: the permission-aware search query/endpoint.

#### P3.6b — Permission-aware search query + endpoint ✅ **DONE (2026-06-02)**
- **`DocumentsService.searchDocuments(query, limit)`**: queries OpenSearch (`multi_match` on `name^2`+`description`, `term tenantId`) → hits in relevance order → **post-filter + hydrate** in one RLS-scoped SQL fetch that applies `FolderAccessService.documentListCondition` (the *same* predicate the list uses, P3.3b) so restricted-subtree docs the caller can't read + any stray cross-tenant id drop out → rows re-sorted into the OpenSearch score order. When the index is disabled (Noop), it **falls back** to the Postgres `list` (ILIKE, same access filter). Response carries `backend: "opensearch" | "postgres"`.
- **`GET /v1/documents/search?q=&limit=`** (`document:read`), declared before `:id` so the literal path isn't captured by the UUID route; empty `q` → 400. `DocumentSearchResponse` contract + OpenAPI entry.
- **Validated**: suite **332/332** (44 suites; +7). e2e `documents-search`: relevance order preserved through hydration; restricted-folder doc filtered for non-grantee (admin bypasses; a grant unlocks); cross-tenant id dropped by RLS; Postgres fallback when index off; empty-`q` 400; `document:read` enforced. **Live smoke** (real OpenSearch): name^2 outranks description-only, non-match + cross-tenant excluded, scores descending. `tsc`/`eslint`/`nest build` clean.
- **ADR-0051** (covers a+b).
**Deferred:** pre-filter/back-fill pass (top-`limit` mostly-inaccessible returns < limit); durable/outbox indexer (best-effort can drift); content extraction (Tika/OCR); other domains + hybrid BM25+vector (P3.7+).
**Depends on:** P3.6a, P3.3b.
**Depends on:** P1.1, P2.1.

### P3.7 — Federated search at `/v1/search` ✅ **DONE (2026-06-02)**
Fan-out to OpenSearch (documents) + Postgres FTS (incidents/cases). Split a/b: **a** = federated backend + RRF merge; **b** = web global-search UI. ADR-0052. ClickHouse-aggregated facets deferred to a later item (confirmed).
**Decisions (confirmed):** merge by **Reciprocal Rank Fusion** (rank-based — OpenSearch BM25 vs Postgres `ts_rank` have incompatible scales); CH facets deferred; backend + web UI (a/b).

#### P3.7a — Federated backend + RRF merge ✅ **DONE (2026-06-02)**
- **`SearchService` rewrite**: incidents/cases via Postgres FTS (P2.11); documents via OpenSearch when `SEARCH_INDEX.active` (hits → access-filtered RLS-scoped hydration → restore OpenSearch order), else FTS fallback. Each domain gated by the caller's read perm + RLS. Per-domain ranked lists fused by **RRF** (`score = 1/(k+rank)`, k=60; ties → raw score then id). `SearchResult` gains `source: "opensearch" | "postgres"`.
- **Folder-access gap closed**: the documents domain in `/v1/search` now applies `FolderAccessService.documentListCondition` + `status='ready'` (both the OpenSearch hydration and the FTS fallback) — the original P2.11 search leaked restricted-folder doc titles/snippets to non-grantees. `SearchModule` imports `FoldersModule`.
- **Validated**: suite **336/336** (45 suites; +4). e2e `search-federated` (faked seam): OpenSearch docs + FTS incidents merged with correct `source` flags + non-increasing RRF; restricted-folder doc hidden from a non-grantee (admin bypasses); FTS fallback when index off (still folder-filtered); no docs without `document:read`. Existing `search.e2e` (6) still green (RRF scores > 0, non-increasing). **Live smoke** (`search-federated.live-smoke.ts`, real OpenSearch): finalized upload indexed (P3.6a) → `/v1/search` returns it `source=opensearch` fused with an FTS incident `source=postgres`; `/v1/documents/search` `backend=opensearch`. `tsc`/`eslint`/`nest build` clean.
- **Deferred → P3.7b**: web global-search UI + ADR-0052.

#### P3.7b — Web global search UI ✅ **DONE (2026-06-02)**
- **`/search` page** (server component reading `?q=` → `authedApiFetch('/v1/search')`) + client `SearchBox` (pushes `?q=`). Results **grouped by type** (Incidents/Cases/Documents) with a per-row **source badge** (opensearch/postgres); incidents link to detail, documents to the list, cases render plain (no detail page yet). Sidebar "Search" entry enabled; `/search` added to the auth-protected middleware matcher.
- **Validated**: `next lint` + `next build` clean (`/search` route built, 2.28 kB). Runtime smoke: `/search?q=…` unauth → 307 → `/login?next=…` (middleware live); `/login` → 200. No API/contract changes → API suite unchanged (336/336).
- **ADR-0052** (covers P3.7a+b).
**Deferred:** command-palette (Cmd-K) quick-search; per-document + case detail pages; highlight snippets; result facets.
**Depends on:** P3.7a.
**Depends on:** P3.6.

### P3.8 — Visual workflow builder (MVP) ✅ **DONE (2026-06-02)**
React Flow + node library + compile-to-Temporal. Split a/b/c/d. ADR-0053.
**Decisions (confirmed):** **generic interpreter workflow** (graph stored as data; one Temporal workflow walks the DAG — no worker redeploy to add/edit a graph); **focused node set** (start, end, notify, delay, condition, create_incident); **manual + event-triggered** start.

#### P3.8a — Definition model + CRUD + DAG validation ✅ **DONE (2026-06-02)**
- **`workflows` table** (`definition` JSONB `{nodes,edges}`, `version`, `enabled`, `trigger_type`/`trigger_event`, RLS, soft-delete) + migration 0025 (CHECK `trigger_type IN ('manual','event')`). Added to `truncateAll`.
- **Contracts** (`workflow.ts`): node-type discriminated union (per-type config: notify/delay/condition/create_incident), edges (with `branch` for conditions), `WorkflowDefinition`, `validateWorkflowDefinition()` (one start, ≥1 end, edges ref nodes, condition has true+false, action nodes 1 outgoing, reachable, acyclic), `Workflow` + CRUD + validate shapes. `workflow:read/write/run` perms (operator: read+run; auditor: read; admin `*`).
- **`WorkflowsService` + Controller**: Zod-parse bodies in the service (deep union — class-validator unwieldy; `@Body() unknown` passes the global ValidationPipe). CRUD + `POST /workflows/validate` (editor feedback). Drafts may be saved incomplete; **enabling requires a valid DAG** (400 otherwise, reason in problem+json `detail`). OpenAPI entries.
- **Validated**: suite **342/342** (46 suites; +6). e2e `workflows`: CRUD + version bump on definition change; enable-gates-on-valid-DAG; `/validate` (valid/invalid/condition graph); malformed node config → 400; `workflow:*` RBAC; cross-tenant RLS → 404. `tsc`/`eslint`/`nest build` clean, migration 0025.
- **Deferred → P3.8b**: the interpreter + run engine.

#### P3.8b — Interpreter Temporal workflow + run engine ✅ **DONE (2026-06-02)**
- **`workflow_runs` table** (immutable graph snapshot + `status`/`trigger`/`input`/`output`/`error`/`temporal_workflow_id`/`started_by`, RLS, migration 0026, CHECK status). Added to `truncateAll`.
- **Generic interpreter** (`temporal/workflows/workflow-interpreter.workflow.ts`): one Temporal workflow walks any DAG passed as `args.definition` — start/end/delay(`sleep`)/condition (`context[path]===equals` → true/false branch) in-workflow; notify/create_incident via activities. Determinism-safe (only `@temporalio/workflow` + a type-only activity contract; graph types declared locally — no `@cmc/contracts` runtime in the sandbox). Step-limit guard. Reports status via `markRunStatus`.
- **Activities** (`workflow-interpreter.{types,activities}.ts`, built from `db` + `notifications`): `markRunStatus` (run row pending→running→completed/failed + output/error/finishedAt), `executeNotify` (`workflow.notify` kind, recipient = `toUserId` or initiator), `executeCreateIncident` (inserts an incident, returns id → `context.lastIncidentId`). Registered in `TemporalWorker`.
- **Run engine** (`WorkflowsService.startRun`/`run`, injects `TEMPORAL_CLIENT`): snapshots the (valid-DAG) graph into a run row, starts `workflowInterpreter` (`wf-run:<id>`), stamps `temporalWorkflowId`; start-failure marks the run failed. `POST /v1/workflows/:id/run` (`workflow:run`, 202) + `GET /:id/runs` + `GET /runs/:runId` (`workflow:read`). Contracts: `WorkflowRun` + statuses + run req/resps. `startRun` is reused by P3.8c (event trigger, system actor). OpenAPI entries.
- **Validated**: suite **346/346** (47 suites; +4). e2e `workflow-runs` (faked Temporal seam): run snapshots + starts the interpreter with the run id + graph; list/get runs; run rejects an invalid DAG (400, no start); `workflow:run` + cross-tenant 404. **Live smoke** (real Temporal worker, `createApplicationContext` with `TEMPORAL_ENABLED`): start→notify→create_incident→end runs to `completed`, real incident + `workflow.notify` notification created, output + finishedAt set. `tsc`/`eslint`/`nest build` clean, migration 0026.
- **Deferred → P3.8c**: event-triggered auto-start.
**Depends on:** P3.8a, P3.1.

#### P3.8c — Event-triggered auto-start ✅ **DONE (2026-06-02)**
- **`WorkflowEventConsumer.handle(env)`** (pure, testable): for a consumed event, computes `${aggregateType}.${eventType}`, finds enabled event-bound workflows in the tenant, and (after a single `EventDedupService.claim`) starts a run of each via `WorkflowsService.startTriggeredRun` (system actor, `trigger='event'`, event payload as input). Dedup is claimed only when a match exists — the common no-match event writes no ledger row.
- **`WorkflowsService.findEnabledEventWorkflows` + `startTriggeredRun`**: context-free (run in `runForTenant`, no request) so the consumer works outside a request; invalid graphs skipped (logged).
- **`WorkflowEventSubscriber`**: durable JetStream consumer (`workflow-trigger`, `filter_subjects: ["tenant.>"]`, `DeliverPolicy.New`), gated on `NATS_ENABLED` + skipped in tests, `nats` dynamic-imported, `nak`-on-failure → at-least-once (dedup makes redelivery safe). Mirrors the P2.4b incident-notifications subscriber.
- **Validated**: suite **351/351** (48 suites; +5). e2e `workflow-triggers` (faked Temporal seam): matching event auto-starts the workflow (run `trigger='event'`, input = payload); idempotent on event id (redelivery → one run); no-match writes no dedup row; disabled workflow not triggered; multiple workflows bound to one event all start. **Live smoke** (real Temporal worker, `createApplicationContext`): feeding the consumer a synthetic `incident.created` auto-starts → interpreter runs to `completed` (real incident + `workflow.notify`); redelivery deduped. `tsc`/`eslint`/`nest build` clean.
- **Deferred → P3.8d**: the React Flow web editor + ADR-0053.
**Depends on:** P3.8b, P2.1.

#### P3.8d — React Flow web editor ✅ **DONE (2026-06-02)**
- **`@xyflow/react`** dep. **`/workflows`** (list: name/trigger/status/nodes/version + "New workflow" client button → creates draft → opens editor). **`/workflows/:id`** editor — React Flow canvas + node palette (one button per type), drag-to-connect edges (condition edges auto-labelled true/false), per-node config inspector, name/enabled/trigger toolbar, **Validate / Save / Run** + recent-runs panel. Server actions (`authedApiFetch`) back create/save/validate/run/list-runs/delete. Sidebar "Workflows" entry enabled; `/workflows` added to the protected middleware matcher.
- **Validated**: `next lint` + `next build` clean (`/workflows` 2.22 kB, `/workflows/[id]` 59.3 kB incl. React Flow). Runtime smoke: both routes 307→`/login` unauthenticated (middleware live). No API/contract changes → API suite unchanged (351/351).
- **ADR-0053** (covers P3.8a–d).
**Deferred:** loops/parallel/sub-workflows/human-approval/HTTP nodes; run-step visualisation; editor polish (undo/autosave).
**Depends on:** P3.8c.
**Depends on:** P3.1.

### P3.9 — External API + API keys + per-tenant quota ✅ **DONE (2026-06-02)**
Split a/b. ADR-0054.
**Decisions (confirmed):** **in-app NestJS guard** (no external gateway); **combined JWT-or-API-key on the existing `/v1`** (a key calls the same endpoints, scopes gate via `@Authorize`); **permission-subset scopes** (RBAC strings ≤ creator's); **per-key + per-tenant Redis quota**.

#### P3.9a — API keys backend ✅ **DONE (2026-06-02)**
- **`api_keys` table** (SHA-256 `key_hash` only — secret shown once; `key_prefix`, `scopes` jsonb, `created_by`, `last_used_at`, `expires_at`, `revoked_at`, RLS, unique hash index) + migration 0027. Contracts `api-key.ts` + `api_key:manage` perm (tenant_admin only).
- **`ApiKeysService`**: mint `cmc_…` key, hash, create/list/revoke; **scopes ≤ creator's permissions** (no escalation, even for admin). Crypto helper `api-key.crypto.ts` (generate/hash/`isApiKey`).
- **Combined auth**: `TenantContextMiddleware` detects a key (`X-API-Key` or `Authorization: Bearer cmc_…`), privileged hash lookup (+ tenant slug join, expiry/revoke/orphan checks), sets an `apikey` principal carrying scopes; best-effort `last_used_at`. `RbacService.resolvePermissions` returns the key's scopes for an api-key principal **before the cache** (no cache poisoning) → `enforce`/`hasPermission` gate the same `/v1` endpoints + downstream filters (search/folder-access) honour scopes.
- **Quota**: global `ApiKeyQuotaGuard` (no-op for JWT/anon) → per-key + per-tenant Redis counters via the existing `RateLimitService` → 429 + `Retry-After`. Config `API_KEY_RATE_*`.
- **`/v1/api-keys`** create/list/revoke (`api_key:manage`, **user-only** — a key can't mint/revoke keys). OpenAPI entries.
- **Validated**: suite **359/359** (49 suites; +8). e2e `api-keys`: create (secret once, **hash at rest = sha256**), auth a `/v1` endpoint within scopes, 403 outside scopes, overreach → 400, revoke → 401, **quota → 429 (+Retry-After)**, management gated (operator 403, key 403), **JWT path unaffected**. `tsc`/`eslint`/`nest build` clean, migration 0027.
- **Deferred → P3.9b**: web admin UI + ADR-0054.
> Env note: a macOS TCC/Docker file-share glitch revoked repo file access mid-item; after restoring access + Docker, the eslint/build/full-suite gates were re-run clean (the e2e had already passed before the glitch).

#### P3.9b — Web API-keys admin UI ✅ **DONE (2026-06-02)**
- **`/admin/api-keys`** (under the admin-only layout): server page fetches `/v1/api-keys` + the caller's `/rbac/me` permissions (the scope-picker set, since key scopes ⊆ creator's). Client `ApiKeysManager`: create (name + scope toggles + optional expiry) with the **secret shown once** (copy/dismiss), list (name/prefix/scopes/last-used/status: active|expired|revoked), revoke (confirm). Server actions (`authedApiFetch`). Admin overview gains an "API Keys" card.
- **Validated**: `next lint` + `next build` clean (`/admin/api-keys` 3.49 kB). Runtime smoke: `/admin/api-keys` unauth → 307 → `/login` (admin gate live). No API/contract changes → API suite unchanged (359/359).
- **ADR-0054** (covers P3.9a+b).
**Deferred:** key rotation / scope-edit (revoke + recreate), outbound webhooks, managed gateway (Kong/Envoy/WAF).
**Depends on:** P3.9a.
**Depends on:** P1.1.

### P3.10 — Wiki (without realtime collab yet) ✅ **DONE (2026-06-03 / ADR-0055)**
Spaces, pages, TipTap editor, version history, comments. Split a/b/c. ADR-0055.
**Decisions (confirmed):** **TipTap/ProseMirror JSON** content (+ derived plaintext for search); **nested ltree page tree per space**; **snapshot-per-save versions**; **tenant-wide `wiki:*` RBAC** (per-space restriction deferred).

#### P3.10a — Spaces + pages + versions backend ✅ **DONE (2026-06-02)**
- **`wiki_spaces`** + **`wiki_pages`** (ltree `path` per space, parent self-FK, GiST, `content` jsonb (ProseMirror doc) + `content_text` derived plaintext, `current_version_no`, tsvector GIN on title+text) + **`wiki_page_versions`** (snapshot per save) + migration 0028 + RLS. Reuses the folders ltree type + move-repath CASE.
- Contracts `wiki.ts` (lenient `ProseMirrorDocSchema` passthrough, WikiSpace/Page/Summary/Version + CRUD/tree). `wiki:read/write/manage` perms (operator read+write, auditor read).
- **`WikiService`/Controller**: space CRUD (manage to create/delete); page CRUD + tree (path-ordered) + move (repath CASE + cycle guard, same-space) + soft-delete subtree; **version snapshot on create (v1) + every update**; list/restore (restore = append a new version + repoint). Plaintext derived server-side (`extractText` walks the doc). OpenAPI entries.
- **Validated**: suite **366/366** (50 suites; +7). e2e `wiki`: space CRUD; nested tree + content round-trip + path order + derived plaintext; update→version bump + list; restore (append-only); move + cycle guard; delete subtree; `wiki:*` RBAC (manage vs write vs read); cross-tenant RLS → 404. `tsc`/`eslint`/`nest build` clean, migration 0028.
- **Deferred → P3.10b/c**: comments; TipTap web editor.

#### P3.10b — Page comments (threaded) backend ✅ **DONE (2026-06-02)**
- **`wiki_comments`** (tenant FK, `page_id`→wiki_pages cascade, `parent_id` self-FK thread, `author_id`→users set-null, `body` text, timestamps, soft-delete) + migration 0029 + RLS (two-GUC) + `pageIdx`. Added to `truncateAll`.
- Contracts: `WikiComment`/`CreateWikiComment` (body 1–10 000, optional nullable `parentId`) + comment/list responses.
- **`WikiService`**: `listComments` (oldest-first), `createComment` (validates a reply's parent is on the **same page** → 400 otherwise), `deleteComment` (**author OR `wiki:manage`**, else 403; `RbacService` injected). `WikiController`: GET/POST `pages/:id/comments` (read / write), DELETE `comments/:id` (write + service-level author/manage check). OpenAPI entries.
- **Validated**: suite **370/370** (51 suites; +1 suite/+4 tests, 0 regressions). e2e `wiki-comments`: create + threaded reply + oldest-first list; cross-page parent → 400; author-delete 204 / non-author-non-manager 403 / manager 204; viewer 403 (read & write) + cross-tenant 404. `tsc`/`eslint`/`nest build` clean, migration 0029.
- ADR-0055 covers a–c (written at P3.10c close).
**Depends on:** P3.10a.

#### P3.10c — Web wiki (TipTap) + ADR-0055 + close P3.10 ✅ **DONE (2026-06-03)**
- **TipTap** v2 (`@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/pm`). `PageEditor` — `useEditor({ immediatelyRender:false })` (SSR-safe), remount-on-`key` for content swaps + `setEditable` for view↔edit, formatting toolbar (B/I, H1–3, lists, quote, code), JSON round-trips straight to the API; prose styles in `globals.css`.
- **`/wiki`** — space cards + create (gated on `wiki:manage`). **`/wiki/[spaceId]`** — three-pane client `WikiWorkspace`: page **tree nav** (indented by ltree depth, inline create at root/child), **editor** (view/edit/save, version badge, delete), tabbed **History / Comments** panel (restore version; threaded comments — reply, delete gated author-or-manage via `userId` from `/rbac/me`).
- `"use server"` actions (`ActionResult<T>`); sidebar "Knowledge Base" enabled; `/wiki` added to auth middleware prefixes.
- **Validated**: web `tsc` + `next lint` + `next build` clean (TipTap bundles into the `/wiki/[spaceId]` chunk). Live smoke: `/wiki` + `/wiki/[id]` 307→`/login` (middleware), `/login` 200, server log clean. Backend suite **370/370** unchanged. ADR-0055 (a–c).
**Depends on:** P3.10b.

### P3.11 — Data import workers ✅ **DONE (2026-06-03 / ADR-0056)**
BullMQ jobs for CSV / Excel / GeoJSON / Shapefile with validation + quarantine. Split a/b. ADR-0056.
**Decisions (confirmed):** first iteration **CSV→incidents + GeoJSON→GIS** (Excel + Shapefile → P3.11b); **per-row validation with partial-commit + a quarantine table** (not all-or-nothing).

#### P3.11a — Import backend (CSV→incidents + GeoJSON→GIS) ✅ **DONE (2026-06-03)**
- **`import_jobs`** (kind, source_key, target_id, status, total/inserted/failed counts, error, created_by) + **`import_row_errors`** (quarantine: row_num, reason, raw jsonb) + migration 0030 + RLS (two-GUC) + `truncateAll`.
- Contracts `import.ts` (`csv_incidents` | `geojson_gis`; `CreateImportRequest` superRefine — geojson requires `targetId`; job + row-error responses). `import:run` / `import:read` perms (operator gets both).
- **Gated BullMQ seam** (`IMPORT_QUEUE` token + Noop/Real + `IMPORTS_ENABLED` factory — `bullmq` never loads in jest) + **`ImportWorker`** (isTest-skipped). Source file pulled from the files bucket via `StorageService.getObjectBytes` (uploaded via the standard flow); `csv-parse` for CSV, native JSON for GeoJSON.
- **`ImportService`**: `create` (gated on the **target-domain write perm** too — no RBAC escalation — then enqueue) + `runJob` (compare-and-set claim queued→processing so a retry can't double-import; download → parse → **per-row validate (zod for incidents / structural for geometry) + SAVEPOINT insert** so one bad row can't abort the job → quarantine the rest; counts + status atomic). Endpoints: POST `/v1/imports`, GET `/v1/imports`, `/:id`, `/:id/errors`.
- **Validated**: suite **375/375** (52 suites; +5). e2e `imports`: CSV partial-commit + quarantine (2 in / 2 quarantined, error rows + reasons); GeoJSON partial-commit (bad geometry quarantined); whole-file fail (missing source); contract 400 (geojson w/o target); RBAC (viewer 403) + **escalation guard** (import:run but no incident:create → 403) + cross-tenant 404. **Live smoke** (real BullMQ worker, `IMPORTS_ENABLED=true` + `NODE_ENV=development`): HTTP create → enqueue → worker → runJob → Postgres+MinIO, job completed (1 in / 1 quarantined). `tsc`/`eslint`/`nest build` clean, migration 0030.

#### P3.11b — Excel + Shapefile + web import UI + ADR-0056 + close P3.11 ✅ **DONE (2026-06-03)**
- **Two new kinds** reusing the P3.11a pipeline (parsers dynamic-imported): **`xlsx_incidents`** (`xlsx`/SheetJS, first sheet, `raw:false` → string cells like CSV → `processIncidentRows`) + **`shapefile_gis`** (`adm-zip` unzip → `shapefile.read` on `.shp`/`.dbf` → GeoJSON features → `processGisFeatures`; coords assumed WGS84, reprojection deferred). `ImportService` refactored: parsers (bytes→rows/features) split from processors (validate + SAVEPOINT partial-commit + quarantine).
- **Source upload**: `POST /v1/imports/upload-init` presigns a PUT to `imports/<tenant>/…` (no document row); browser PUTs to MinIO; then `POST /v1/imports`. Contract `ImportUploadInit*`.
- **Web `/imports`** (sidebar "Data Import" + middleware-protected): job table (status, inserted/total, quarantined, expandable quarantine viewer) + "New import" form (kind + target-layer-for-GIS + file → upload-init → presigned PUT → create) via `"use server"` actions; refresh button to watch progress.
- **Validated**: API suite **378/378** (52 suites; +3). e2e `imports` 8/8: CSV + XLSX partial-commit/quarantine, GeoJSON + **Shapefile** (real hand-built `.shp` zip) feature import, upload-init→PUT→import round-trip, whole-file fail, gis-without-target 400, RBAC + escalation guard + cross-tenant 404. Web `tsc`/`lint`/`build` clean; `/imports` 307→`/login` live smoke. ADR-0056 (a+b).
**Depends on:** P3.11a.

### P3.12 — Chat MVP (no E2EE, no video yet) ✅ **DONE (2026-06-03 / ADR-0057)**
Channels, threads, mentions, reactions; persisted to Postgres + projected to CH; realtime via P2.3. Split a/b. ADR-0057.
**Decisions (confirmed):** first iteration **channels + messages + realtime** (threads/reactions/mentions → P3.12b); **tenant-open channels** (`chat:read`/`write`/`manage`, no per-channel membership in MVP); **CH projection deferred** (Postgres only).

#### P3.12a — Channels + messages + realtime backend ✅ **DONE (2026-06-03)**
- **`chat_channels`** + **`chat_messages`** (author set-null, `edited_at`, soft-delete, feed index `(tenant,channel,created_at)`) + migration 0031 + RLS (two-GUC) + `truncateAll`.
- Contracts `chat.ts` (channel + message + `before`-cursor list w/ `nextBefore`). `chat:read`/`chat:write`/`chat:manage` perms (operator read+write, auditor read).
- **`ChatService`/Controller**: channel create (`manage`)/list/get/delete (soft-delete + cascade messages); message post (`write`)/list (oldest→newest, `before` cursor)/edit/delete (**author OR `chat:manage`**). Every mutation **emits a `chat` event to the outbox in the same request tx** (atomic) → relay → NATS `tenant.<id>.chat.<eventType>.v1`.
- **Realtime via P2.3**: added `chat → chat:read` to `SUBJECT_AGGREGATE_PERMISSION`, so a client subscribes to `tenant.<id>.chat.>` with `chat:read` and the fan-out delivers channel/message events live.
- **Validated**: suite **383/383** (53 suites; +5). e2e `chat`: channel CRUD (+non-manager 403); message post/list/`before`-pagination + **outbox emit**; edit/delete author-vs-manager-vs-403; RBAC (viewer 403) + cross-tenant 404. **Live smoke** (real NATS→WS, `NATS_ENABLED`+`REALTIME_ENABLED`+`NODE_ENV=development`): HTTP post → outbox → relay flush → NATS → fan-out → WS `chat:read` subscriber receives `chat.message_created`. `tsc`/`eslint`/`nest build` clean, migration 0031. **NB for web (P3.12b):** the WS frame's `payload` is the **full event envelope**; chat fields are under `payload.payload`.

#### P3.12b — Threads + reactions + mentions + web chat UI + ADR-0057 + close P3.12 ✅ **DONE (2026-06-03)**
- Backend: **threads** (`parent_id` self-FK, one level — reply's parent must be top-level same-channel; feed lists top-level + `replyCount`; replies endpoint), **reactions** (`chat_reactions` unique(message,user,emoji) → idempotent; messages enriched with `{emoji,count,mine}[]`), **mentions** (explicit `mentions: userId[]` → validated tenant users → `chat.mention` notifications). Migration 0032. Each reaction/thread event also emits to the outbox.
- Web **`/chat`** (sidebar "Chat" + middleware-protected): three-pane workspace — channel list (+create for managers), message stream + composer, per-message emoji reactions (toggle chips w/ count+mine), thread side-panel (reply + reply-count); `"use server"` actions. **Browser uses a 4 s poll** (not WS) to avoid exposing the JWT — the realtime backend is built/live-smoked; a short-lived WS-ticket endpoint is the documented follow-up.
- **Validated**: API suite **386/386** (53 suites; +3). e2e `chat` 8/8 (incl threads/reactions/mentions). Web `tsc`/`lint`/`build` clean; `/chat` 307→`/login` smoke. ADR-0057 (a+b). Deferred: membership/private channels, presence/typing/read-receipts, mention-autocomplete UI, CH projection, WS-ticket browser realtime.
**Depends on:** P3.12a.

### P3.13 — HA introduction ✅ **DONE (2026-06-03 / ADR-0058)**
2× API instances; Postgres primary + replica; PgBouncer; Redis Sentinel.
**Decisions (confirmed):** **pragmatic HA + correctness** (not a full local cluster); **replica/Sentinel as compose profiles/configs** (documented target, not default-up).
- **API horizontally scalable (real)**: dropped `container_name` from `api` in deploy-compose (`docker compose up --scale api=N`); Caddy API site → **dynamic DNS upstreams** (`dynamic a` + `lb_policy round_robin`, refresh 5s) → live load-balance across replicas.
- **N-instance correctness**: relay/sealer/export/projection already `pg_advisory_xact_lock`-guarded; **closed the one gap** — the daily retention sweep now takes `pg_try_advisory_xact_lock(40_211_500)` (no double-sweep/dup-audit). Verified safe: Redis-held sessions/rate-limit/RBAC cache, per-instance NATS fan-out (realtime reaches all instances), shared BullMQ queue.
- **PgBouncer (real)**: `pgbouncer` (transaction pooling) fronts Postgres; runtime `DATABASE_URL`→`pgbouncer:6432`. Safe: tx-scoped GUCs (`is_local`) + `prepare:false`; owner/migration path bypasses the pooler.
- **Stateful HA sample (documented)**: `infra/ha/docker-compose.ha.yml` — Postgres primary+streaming-standby + PgBouncer + Redis master/replica + **3-node Sentinel** (quorum 2) + `redis-sentinel.conf` + README. `docs/runbooks/ha.md`.
- **Validated**: `tsc` clean; retention e2e **6/6**; full suite **53/386** (0 regressions); `docker compose config` exit 0 on deploy-compose + ha-compose; `caddy validate` → valid. **Deferred (documented)**: app read-replica routing, Redis Sentinel client, failover automation, multi-region (P4.6).

### P3.14 — SOC 2 control mapping ✅ **DONE (2026-06-03)**
Document control coverage and gaps. Begin evidence collection.
- **`docs/compliance/soc2-control-mapping.md`**: maps implemented technical controls to the Trust Services Criteria — Common Criteria **CC1–CC9** + **Availability (A1)** + **Confidentiality (C1)** — each row criterion→status(✅/🟡/🔴/🏛)→evidence (ADR/code/runbook). Honest framing: engineering self-assessment, not a SOC 2 report; org/process controls flagged 🏛 (management).
- **Prioritized gap analysis** (technical: at-rest enforcement, mTLS/Vault-prod, CI security scanning, staging+release gate, SIEM, DR test, access reviews; organizational: policy set, risk register, vendor inventory, HR security).
- **`docs/compliance/evidence-register.md`**: starter register — system-produced evidence already available (audit log + chain-verify + anchors, alerts, metrics, backup/restore drill, CI runs, `/rbac/me` access reviews, …) with cadence/owner, plus the manual evidence still to create, and a Type I→II path.
- No ADR (the compliance docs are the deliverable). No code change → suite unaffected.

### P3.15 — Daily Merkle root anchoring ✅ **DONE (2026-06-03 / ADR-0059)**
Extension of P1.11. Daily root committed to MinIO Object Lock bucket (compliance mode).
- **Core was P1.11b** (daily 1 AM cron → seal → Merkle-root closed `(tenant,day)` chains → WORM Object-Lock write + record + verify-against-anchor). P3.15 **hardens** it:
- **HA-safe anchoring**: `anchorChain` takes `pg_advisory_xact_lock(40_211_600)` across existing-check→WORM-write→insert, so concurrent daily crons on N API instances can't double-write the object or race the unique `(scope,date)` insert (idempotent loser).
- **COMPLIANCE-mode prod guard**: boot-time loud error if `NODE_ENV=production` + anchoring enabled + `AUDIT_ANCHOR_LOCK_MODE≠COMPLIANCE` (GOVERNANCE anchors are deletable → not true WORM).
- **Anchor-gap visibility**: `anchorStatus` + `GET /v1/audit/anchor/status?days=N` (`tenant:manage`) — per-day sealed/anchored + **`gaps`** (past days with sealed rows but no anchor → dropped-day evidence). Contract `AuditAnchorStatusResponse`.
- **Validated**: `tsc`/`eslint`/`nest build` clean; e2e `audit-anchor` **9/9** (+3: gap detector, concurrent-anchor single-WORM-write, status endpoint authz); full suite **53/389** (0 regressions). Deferred: hard-refuse on GOVERNANCE-in-prod, Alertmanager rule on `gaps`, system-scope status surface.

---

## P4 — Enterprise scale (Horizon 4) ✅ COMPLETE (2026-06-03)
**All items done (P4.1–P4.3, P4.5–P4.8 / ADR-0060…0066); P4.4 Mobile companion DEFERRED.** Next: P5 — National scale.

### P4.1 — Realtime collaboration (Yjs) ✅ COMPLETED 2026-06-03 (a, b, c / ADR-0060)
Across documents (Wiki pages, dashboard editing, workflow diagrams). Presence cursors. Anchored comments. Offline reconcile. **Cost: XL.** Delivered a/b/c for the wiki; dashboards/diagrams reuse the same substrate (follow-on). ADR-0060.

- **P4.1a — Collab substrate ✅ COMPLETED 2026-06-03.** `collab_docs` table (one row per Hocuspocus doc `name` e.g. `wiki.<pageId>`, `state bytea` = `Y.encodeStateAsUpdate`, tenant-cascade, RLS; migration 0033). Gated-lazy-seam `CollabServer` (dedicated Hocuspocus/Yjs WS on `HOCUSPOCUS_PORT` 3002, **separate** from the P2.3 broadcast plane) — `@hocuspocus/server`+`yjs` dynamic-imported (never enter jest); started **solely** on `HOCUSPOCUS_ENABLED` (defaults false → off in the default suite; the usual `NODE_ENV==='test'` skip is dropped so the live smoke boots the real server under a light test-mode app). `CollabService` (decoupled, e2e-testable without the WS): `authorize` (JWT HS256+issuer → page-in-tenant → `wiki:write`), `loadDocument` (stored `Y.Doc` else seed from page TipTap JSON via `TiptapTransformer.toYdoc`), `storeDocument` (debounced — persist bytes **and** snapshot back to `wiki_pages.content`+derived plaintext so search/non-collab reads/versions stay current). Config `HOCUSPOCUS_ENABLED`/`_PORT`/`_SNAPSHOT_DEBOUNCE_MS`. e2e `collab` **3/3**; **headless live smoke 1/1** (two real `@hocuspocus/provider` Node clients → CRDT sync + persistence). Suite **54 suites / 392 tests** green, zero regressions. **BFF:** browser gets a short-lived WS ticket, never the raw JWT (P4.1b). `apps/api/src/modules/collab/`, `packages/db/src/schema/collab-docs.ts`.
- **P4.1b — Web collaborative wiki editor ✅ COMPLETED 2026-06-03.** Backend ticket plane: `POST /v1/collab/ticket` (`@Authorize("wiki:write")` + per-page tenant check → 403/404) mints a **single-use, short-lived Redis ticket** (`collab:ticket:<rand>`, TTL `HOCUSPOCUS_TICKET_TTL_SECONDS`); the WS handshake `authorizeConnection` tries `consumeTicket` (GETDEL) then falls back to JWT (tests/live-smoke). Contracts `collab.ts`; config `HOCUSPOCUS_PUBLIC_URL` + `…_TICKET_TTL_SECONDS`; `CollabServer` re-gated to start solely on `HOCUSPOCUS_ENABLED`. Web: BFF route `/api/collab/ticket` (attaches bearer server-side — browser never sees the JWT); `CollabPageEditor` = TipTap `Collaboration`(history off) + `collaboration-cursor` + `@hocuspocus/provider` bound to a `Y.Doc`, ticket fetched per (re)connect via the provider `token` function; presence cursors (CSS in globals). `WikiWorkspace` **auto-collab with manual fallback**: Edit → connect; live → "● Live · N editing" + "Done" (body auto-persists; title rename = title-only PATCH); on feature-off/no-perm/unreachable → the existing save-based `PageEditor`. e2e `collab` **8/8**; live smoke now also proves the **ticket** path over the real WS; web `tsc`/`lint`/`build` green; suite **54/397**, zero regressions. `apps/api/src/modules/collab/`, `apps/web/src/app/wiki/[spaceId]/collab-page-editor.tsx`, `apps/web/src/app/api/collab/ticket/`.
- **P4.1c — Anchored comments + offline + close ✅ COMPLETED 2026-06-03.** Anchored comments **extend `wiki_comments`** (migration 0034): nullable `anchor` (encoded Yjs relative positions `{from,to}` via `y-prosemirror` — auto-rebase on edits) + `anchor_text` (quoted snapshot); reuses RBAC/notifications/audit/panel, queryable + durable when collab is off; top-level only (replies drop the anchor). Web: `comment-anchor.ts` (encode/decode via the y-prosemirror binding), `CommentHighlight` TipTap extension (decorations recomputed every transaction so highlights track edits; click → flash the comment), a **floating "Comment" bubble** on text selection, and the side panel shows a 📌 quoted snippet + flashes the active comment. **Offline reconcile** via `y-indexeddb` (edits persist locally + merge on reconnect; "Offline — saved locally" pill). Deps (pinned): `y-prosemirror` 1.3.7, `y-indexeddb` ^9. e2e `wiki-comments` **5/5** (anchor round-trip; anchors ignored on replies); suite **54/398**, zero regressions; web `tsc`/`lint`/`build` green. ADR-0060 (covers P4.1 a–c). **Coverage boundary:** the in-browser relative-position encode/decode + decorations are covered by build + the backend anchor round-trip (a Playwright two-browser test is a follow-on). `apps/web/src/app/wiki/[spaceId]/{comment-anchor,comment-highlight}.ts(x)`.

### P4.2 — Video conferencing (LiveKit + coturn) ✅ COMPLETED 2026-06-03 (a, b, c / ADR-0061)
SFU, TURN/STUN, recording via egress, calendar integration. **Cost: XL.** Delivered a/b/c (rooms, web join, recording, incident links); calendar scheduling + SFU clustering + case-detail "Start call" = follow-ons. ADR-0061.

- **P4.2a — Video substrate ✅ COMPLETED 2026-06-03.** `livekit-server-sdk`; config `LIVEKIT_ENABLED`(false)/`_URL`/`_API_URL`/`_API_KEY`/`_API_SECRET`/`_TOKEN_TTL_SECONDS`. **Gated dev containers** `livekit` (livekit/livekit-server, `infra/livekit/livekit.yaml` — keys match the API) + `coturn` in dev-compose. `video_rooms` table (migration 0035, RLS; standalone with reserved nullable `linked_type`/`linked_id`). Perms `video:read`/`write`/`manage` (operator gets read+write, auditor read). Contracts `video.ts`. `VideoService` (gated-lazy seam — `livekit-server-sdk` dynamic-imported): room CRUD; **room-scoped token mint** (`AccessToken` → roomJoin grant, pure JWT signing so it's testable without a running SFU; returns `enabled`); `close` (creator or `video:manage`; best-effort SFU `deleteRoom` when enabled). The SFU room auto-creates on first join. `VideoController` (`/v1/video/rooms` CRUD + `/:id/token` + `/:id/close`, `@Authorize`). **BFF:** browser gets the short-lived room-scoped LiveKit token, never the platform JWT. e2e `video` **6/6** (CRUD; token mint + JWT-grant decode; RBAC; tenant isolation; link validation; close + closed-room 409); **live smoke 1/1** (real SFU accepts the dev key via `RoomServiceClient`). Suite **55 suites / 404 tests**, zero regressions. `apps/api/src/modules/video/`, `packages/db/src/schema/video-rooms.ts`.
- **P4.2b — Web video rooms + join UI ✅ COMPLETED 2026-06-03.** Deps `@livekit/components-react`/`-styles` + `livekit-client`. BFF token route `/api/video/token` (attaches bearer server-side → `/v1/video/rooms/:id/token`; passes through 403/404/409). Server actions (list/create/close via `authedApiFetch`). `/video` page (gated `video:read`; server-fetches rooms): `VideoWorkspace` (client) — open/closed room list, create (`video:write`), close (creator or `video:manage`), **Join** → BFF token → mounts LiveKit's prebuilt `<VideoConference>` (grid, device controls, screenshare, leave) via `next/dynamic({ssr:false})` `RoomStage`; "video not enabled" fallback when `enabled:false`. Sidebar "Video" entry enabled + gated on `video:read`; middleware protects `/video`. **BFF:** browser holds only the room-scoped LiveKit token. Web `tsc`/`lint`/`build` green; smoke: `/video`→307 login, `/api/video/token`→401. `apps/web/src/app/video/`, `apps/web/src/app/api/video/token/`.
- **P4.2c — Recording + links + close ✅ COMPLETED 2026-06-03.** **Recording (manual):** `video_recordings` (migration 0035→0036, RLS); `VideoService` start (RoomCompositeEgress → MP4 in MinIO at `recordings/<tenant>/<room>/<id>.mp4`; gated → 503 when egress off; `video:manage`) / stop / list / presigned download (StorageService). Endpoints `POST /rooms/:id/recordings`, `POST /recordings/:id/stop`, `GET /rooms/:id/recordings`, `GET /recordings/:id/download`. **Egress infra**: `livekit-egress` opt-in compose profile + `infra/livekit/egress.yaml` + redis added to `livekit.yaml`. **Incident links**: `linked_type`/`linked_id` activated — `createRoom` accepts a link, `GET /rooms?linkedType=&linkedId=` filters, incident detail gets "Start video call" + linked-room list → `/video?join=<id>` auto-joins. Web: in-call Record/Stop + recordings download (`video:manage`); `IncidentVideo` widget. e2e `video` **9/9** (+recording gating/list/download, link filter); suite **55/407**, zero regressions; web `tsc`/`lint`/`build` green. ADR-0061. **Boundary:** real WebRTC media + egress aren't headless-tested (manual via `--profile egress`); calendar scheduling + case-detail "Start call" + SFU clustering = follow-ons.

### P4.3 — Operational Monitoring Center ✅ COMPLETED 2026-06-03 (a, b, c / ADR-0062)
Multi-monitor wall view, alert ticker, time-replay (consume event log). Lifts the disabled "Command Center" sidebar entry into reality. **Cost: XL.** Delivered a/b/c (polled wall + ticker + audit_log replay scrubber); WS-push + ClickHouse-backed counts + multi-monitor presets = follow-ons. ADR-0062.

- **P4.3a — Monitoring backend ✅ COMPLETED 2026-06-03.** New `monitoring:read` perm (operator + auditor + admin). Contracts `monitoring.ts`. `MonitoringService` (pure Postgres, RLS — no ClickHouse dependency so the wall is always available + testable): `summary()` = live snapshot (incidents `active` + `byStatus` + `bySeverity`, `recentIncidents`, `recentEvents` from `audit_log`, open video-room count); `replay(from,to,limit)` = `audit_log` action timeline over a window, ascending, capped 2000. `MonitoringController` `GET /v1/monitoring/summary` (polled by the wall) + `GET /v1/monitoring/replay?from=&to=&limit=`, both `@Authorize("monitoring:read")`. e2e `monitoring` **5/5** (summary counts + recent events; replay window/ascending; bad-window 400; RBAC 403; tenant isolation). Suite **56 suites / 412 tests**, zero regressions. `apps/api/src/modules/monitoring/`.
- **P4.3b — Web wall view + alert ticker ✅ COMPLETED 2026-06-03.** `/monitoring` page (gated `monitoring:read`, server-fetches the summary) → `MonitoringWall` (client) **polls `/monitoring/summary` every 4s** (server action) with a live/stale indicator. KPI tiles (active incidents, SEV-1, open calls, recent-event count), by-severity bars + by-status counts, recent-incidents list (→ `/incidents/[id]`), and a live **alert ticker** (recentEvents, outcome dot + time + action). Lifted the disabled **"Command Center"** sidebar entry → `/monitoring`, gated `monitoring:read`; middleware protects `/monitoring`. Web `tsc`/`lint`/`build` green; smoke `/monitoring`→307 login. `apps/web/src/app/monitoring/`.
- **P4.3c — Time-replay scrubber + close ✅ COMPLETED 2026-06-03.** Web `ReplayPanel` on `/monitoring`: datetime-local window picker → loads `/monitoring/replay`, then a scrubber (range slider) + **Play/Pause** auto-advance steps through the `audit_log` timeline as it happened (current-time readout + a sliding 40-event feed with the current event highlighted). Web `tsc`/`lint`/`build` green. ADR-0062 (covers P4.3 a–c). `apps/web/src/app/monitoring/replay-panel.tsx`.

### P4.4 — Mobile companion (React Native) ⏸ DEFERRED (decision 2026-06-03)
Field operations, approvals, alerts, map. Self-hosted UnifiedPush. **Deferred:** a native RN app is a large new surface (new toolchain, native builds, stores) that doesn't fit the web+api monorepo or the headless implement·test·validate cycle in this environment. Revisit later; the approach (installable **PWA** on the existing Next web with web-push/UnifiedPush, vs full React Native) will be chosen at that point. Proceeding to P4.5.

### P4.5 — Media management ✅ COMPLETED (2026-06-03)
FFmpeg transcoding workers, HLS streaming, watermarking. **Cost: XL.** Split a/b/c; ADR-0063 covers a–c. Media is a layer over uploaded **documents**; HLS is served through a **BFF proxy** (per-request RBAC, no JWT in the player).

- **P4.5a — Media substrate ✅ COMPLETED 2026-06-03.** New `media:read`/`media:write` perms (operator+auditor). `media_assets` table (FK documents, kind/status/playlistKey/posterKey/duration; RLS; migration 0037). **Gated BullMQ `media-transcode` seam** (`MEDIA_TRANSCODE_ENABLED`) + worker (isTest-skipped; `bullmq`/`ioredis` dynamic-imported) → `MediaService.transcode` shells out to **ffmpeg → HLS → S3** under `media/<tenant>/<asset>/`. Contracts `media.ts`. `MediaService`: `requestTranscode` (from a document → asset pending + enqueue), list/get, and the **BFF HLS proxy** — `getPlaylist` (fetch `.m3u8` from S3, rewrite segment URIs → `seg/<name>`) + `getSegment` (proxy `.ts` bytes, path-traversal-guarded). `MediaController` `POST /v1/media/transcode`, `GET /assets`, `/assets/:id`, `/assets/:id/playlist.m3u8`, `/assets/:id/seg/:name` (StreamableFile) — all `@Authorize`. e2e `media` **3/3** (transcode→pending + list/get; RBAC + unknown-doc/cross-tenant 404; HLS proxy playlist-rewrite + segment bytes + invalid-name 400 + cross-tenant 404). Suite **57 suites / 415 tests**, zero regressions. **Boundary:** real ffmpeg→HLS isn't headless-tested (worker gated off in tests; the proxy is tested against seeded HLS in MinIO). `apps/api/src/modules/media/`.
- **P4.5b — Web media + HLS player ✅ COMPLETED 2026-06-03.** `hls.js` dep. **BFF HLS proxy routes** `/api/media/[id]/playlist.m3u8` + `/api/media/[id]/seg/[name]` (attach bearer server-side → API; the player streams same-origin, no JWT in browser). Server actions (list/transcode). `/media` page (gated `media:read`) → `MediaWorkspace` (client): asset list with status badges (polls 5s while pending/processing), "Make streamable" (documentId → `requestTranscode`, `media:write`), and a **`MediaPlayer`** (`hls.js`, dynamic ssr:false, native-HLS fallback) playing the proxied playlist. Sidebar "Media" entry (replaces the disabled "Files"), gated `media:read`; middleware protects `/media`. Web `tsc`/`lint`/`build` green; smoke `/media`→307 + playlist proxy→401. `apps/web/src/app/media/`, `apps/web/src/app/api/media/`. (Document-picker integration on the documents page = follow-on; today a document ID is entered directly.)
- **P4.5c — Watermarking + close ✅ COMPLETED 2026-06-03.** Optional **burned-in text watermark**: `media_assets.watermark` (migration 0038), `CreateMediaTranscodeSchema.watermark` (≤100 chars) + `MediaAssetSchema.watermark`. `MediaService.transcode` adds an ffmpeg **`drawtext`** filter (bottom-left, semi-transparent white on a dark box) when set — text shell-escaped for the filtergraph (`\ ' : %`); optional `MEDIA_WATERMARK_FONT` → `fontfile`. Burned into pixels → survives download/screen-capture (unlike a player overlay). Web: watermark `<input>` on the "Make streamable" form → `requestTranscodeAction(documentId, watermark?)`. e2e `media` **4/4** (added watermark round-trip: provided→stored, omitted→null). Suite **57 suites / 416 tests**, zero regressions; web `tsc`/`lint`/`build` green; smoke `/media`→307 + playlist proxy→401. **ADR-0063** covers P4.5 a–c. **Boundary:** real ffmpeg watermark burn-in is a manual/live concern (worker gated off in tests). **P4.5 closed; matrix row 3.24 → 🟢.**

### P4.6 — Regional segmentation (was: Multi-region active-passive DR) ✅ COMPLETED (2026-06-03)
**Reframed 2026-06-03** to deployment reality: the system is **single-site** (server + backups at the head office), so physical multi-region DR — cross-datacenter logical replication, regional Tempo+Loki, DNS-level failover — is **out of scope** (no second site exists). The one DR carry-over is an **off-site backup** recommendation (follow-on; co-locating backups with the server means a site loss takes both). Instead "region" becomes a **logical division of users + operational data within the tenant**: regional users see only their own region, the **head office (`region:all`) sees all regions** — for organizational clarity and access separation. Decisions (2026-06-03): region = dimension **inside the tenant** (not a separate tenant); **hard** separation + HQ sees all; scope **incidents + cases** first; **seed Tajikistan regions + admin CRUD**. **Cost: L.** Split a/b/c; ADR-0064 lands with P4.6c.

- **P4.6a — Regions substrate ✅ COMPLETED 2026-06-03.** New perms `region:read`/`region:manage`/`region:all` + system role **`hq`** (Head Office: region:read + region:all); operator/auditor get `region:read`, tenant_admin gets all via `*`. `regions` table (per-tenant `code`+`name`, unique (tenant, code), RLS, migration **0039**) + `users.region_id` (FK regions, on-delete set-null). Contracts `region.ts` (+ `DEFAULT_TJ_REGIONS`: Душанбе / Согдийская обл. / Хатлонская обл. / ГБАО / РРП). `RegionsService` + `RegionsController`: `GET /v1/regions` (region:read), `POST`/`PATCH`/`DELETE` (region:manage) — delete guarded (409) if users are assigned. User→region assignment rides the existing `PATCH /v1/users/:id` (`regionId`, validated in-tenant → 404 if unknown). Region seed `ensureDefaultRegionsForTenant` wired into the dev seed + e2e fixtures (mirrors the RBAC seed). e2e `regions` **5/5** (seed + RBAC list/403; create + dup 409 + bad-code 400 + operator 403; update + cross-tenant 404; user assign/clear + unknown 404; delete-guard 409 → 204). Suite **58 suites / 421 tests**, zero regressions (rbac role-set assertions updated for `hq`). `apps/api/src/modules/regions/`. **Enforcement (filtering incidents/cases) is P4.6b.**
- **P4.6b — Hard region scoping on incidents + cases ✅ COMPLETED 2026-06-03.** `region_id` (FK regions, set-null) on **incidents** + **cases** (migration **0040**; structured + separate from the incidents free-text `region` label; RLS unchanged). **`RegionScopeService.current()`** (in RegionsModule) resolves the actor's `{ seeAll, regionId }` — `seeAll` for `region:all` (head office), API-key principals, or no request context (cron/consumer → unscoped, backward-compatible); else the actor's own `users.region_id`. **`regionScopeCondition(col, scope)`** → `region_id IS NOT DISTINCT FROM $::uuid` (so a null-region actor matches null-region rows; HQ via `seeAll`). Applied to incidents `list`/`getDetail`/`stats` and cases `list`/`getDetail`/`stats`/`listActivity`/`addComment` (out-of-region detail/mutation → clean 404, since update/transition/assign/delete funnel through the scoped `getDetail`). `create` **stamps the creator's region**. `regionId` exposed on `IncidentSummary` + `CaseSummary`. e2e `region-scoping` **3/3** (create-stamp + regional list isolation + HQ-sees-all; cross-region detail/activity 404; cases mirror). Suite **59 suites / 424 tests**, zero regressions; `tsc`/eslint clean. **Boundary (follow-on):** the monitoring wall (P4.3, queries incidents directly) + ClickHouse analytics (P2.6) are not yet region-scoped — HQ-oriented aggregates; flagged for P4.6c / later. `apps/api/src/modules/regions/region-scope.service.ts`.
- **P4.6c — Web + close ✅ COMPLETED 2026-06-03.** **`/admin/regions`** (list + create/rename/delete, gated `region:manage`; read-only otherwise) + admin-overview card. **User→region assignment** on `/admin/users` (per-row dropdown → `PATCH /v1/users/:id` `regionId`; new Region column). **Incidents**: structured region **badge** (id→name) on list + detail, and a **zone filter** dropdown → new `GET /v1/incidents?regionId=` backend filter (`ListIncidentsQuery.regionId`, composes with the scope condition). Shared `lib/regions.ts` (`fetchRegions`/`regionNameMap`). **ADR-0064** covers P4.6 a–c. Web `tsc`/`lint`/`build` green; smoke `/admin/regions`→307. **Cases web has no UI yet → its region badge/filter is a follow-on** (cases-web). `apps/web/src/app/admin/regions/`, `apps/web/src/lib/regions.ts`, `apps/web/src/app/incidents/`. **P4.6 closed.**

**P4.6 follow-ons:** region-scope the monitoring wall (P4.3) + ClickHouse analytics (P2.6); cases web UI (+ region there); HQ region-picker on create; consolidate incidents free-text `region` into `region_id`; **off-site backup** (the single-site DR carry-over).

### P4.7 — Vault production ✅ COMPLETED (2026-06-03)
Production secrets posture. **Decisions (2026-06-03):** prod auth via **AppRole + KV v2** (extending the P2.14 loader); **dynamic DB credentials** via the Vault DB secrets engine as a **gated seam** (live-smoke vs dev-Vault; off → static DATABASE_URL); **Linkerd dropped** — it is a Kubernetes service mesh and the deployment is single-site docker-compose (not k8s), so mTLS to Postgres/Redis becomes a **TLS config follow-on**, not Linkerd. Split a/b; ADR-0065 lands with P4.7b. **Cost: L.**

- **P4.7a — Production Vault (AppRole + KV v2) ✅ COMPLETED 2026-06-03.** Extended the P2.14 in-process boot loader (`src/config/vault-secrets.ts`) with a production auth method: `VAULT_AUTH_METHOD` (`token` dev | `approle` prod). AppRole login (`POST /v1/auth/{VAULT_APPROLE_MOUNT}/login` with `VAULT_ROLE_ID`+`VAULT_SECRET_ID` → `client_token`), then the KV v2 read uses the issued token; the `token` method (`VAULT_TOKEN`) stays the dev default → backward-compatible. New config keys `VAULT_AUTH_METHOD`/`VAULT_ROLE_ID`/`VAULT_SECRET_ID`/`VAULT_APPROLE_MOUNT`. Loader stays a pre-DI async fn with injectable `env`+`fetch` → hermetic. e2e `vault-secrets` **7/7** (+2: AppRole login→KV with the issued token; approle-without-creds error). Suite **59 suites / 426 tests**, zero regressions; `tsc`/eslint clean. **Boundary:** real Vault AppRole is a live-smoke (dev-Vault container); headless fakes `fetch`. `apps/api/src/config/vault-secrets.ts`.
- **P4.7b — Dynamic DB credentials + close ✅ COMPLETED 2026-06-03.** Second boot loader `src/config/vault-db-credentials.ts` (gated `VAULT_DB_CREDS_ENABLED`): leases short-lived Postgres creds from `{VAULT_DB_MOUNT}/creds/{VAULT_DB_ROLE}` (reusing `resolveVaultToken`) and **swaps them into `DATABASE_URL`'s userinfo** (host/port/db/query kept) before validation → the Drizzle pool sees leased creds, `ConfigService` unchanged. Background **renewer** (`renewVaultLease`, `main.ts`, ~½ TTL) keeps the lease alive to `max_ttl`. Off → static `DATABASE_URL` (backward-compatible); `DATABASE_OWNER_URL` stays static. Secrets never logged (user+TTL only). Config `VAULT_DB_CREDS_ENABLED`/`VAULT_DB_MOUNT`/`VAULT_DB_ROLE`. e2e `vault-db-credentials` **6/6** (gating; DB-engine read + userinfo swap; AppRole reuse; missing role/URL; lease renew). Suite **60 suites / 432 tests**, zero regressions; `tsc`/eslint clean. **ADR-0065** covers P4.7 a–b. **Linkerd deferred (non-k8s single-site) + mTLS/TLS-to-Postgres/Redis follow-on.** **Boundary:** real Vault DB engine = manual live-smoke. **P4.7 closed.**

### P4.8 — Realtime analytics (ClickHouse-native) ✅ COMPLETED (2026-06-03)
**Decisions (2026-06-03):** **ClickHouse-native** (reuse the P2.5/P2.2 projections), **not Flink** (heavy JVM streaming — N/A for single-site/headless → follow-on); anomaly detection via **rolling mean+stddev → Z-score** (deterministic, e2e-testable); delivery = **endpoint + web widget + proactive notifications**. Split a/b; ADR-0066 lands with P4.8b. **Cost: L.**

- **P4.8a — Anomaly detection backend ✅ COMPLETED 2026-06-03.** Pure `detectAnomalies` (rolling mean+stddev → Z-score over a baseline window; `minStddev` **floor** so a flat/quiet baseline neither divides-by-zero nor flags single-unit noise, while a real jump still trips) — deterministic, no I/O. `DashboardAnalyticsService.anomalies(tenantId, {days,window,zThreshold})` pulls the daily incident series from ClickHouse (tenant-scoped `incident_daily_stats_by_region`), **gap-fills via `buildDailyTrend`** (quiet days → dips), runs the detector; degrades to `source:"unavailable"` when CH is off. Contracts `AnomalyPoint`/`AnomaliesResponse`. `GET /v1/analytics/anomalies` (`incident:read`; query `days`/`window`/`z`). e2e `analytics-anomalies` **9/9** (pure: spike/dip/flat/short-series; CH-off → unavailable; faked-CH endpoint spike + custom-z + 401 + 403). Suite **61 suites / 441 tests**, zero regressions; `tsc`/eslint clean. **Boundary:** the real CH query is a live-smoke. `apps/api/src/modules/analytics/anomaly-detector.ts` + `dashboard-analytics.service.ts`.
- **P4.8b — Web widget + proactive + close ✅ COMPLETED 2026-06-03.** `AnomalyAlertService` — a **gated** background scan (`ANALYTICS_ANOMALY_DETECTOR_ENABLED` + CH active; interval isTest-skipped, `scan()` called directly in tests) that runs the P4.8a detector per tenant, keeps only anomalies from the last `RECENT_DAYS` (no backfill replay), and for each **new** one fans an `analytics.anomaly` notification (P1.6) to `monitoring:read` holders — **deduped once per (tenant, day, direction)** via a Redis `SET NX` key. New notification kind `analytics.anomaly`. **Web**: dashboard **anomaly widget** (server-seeded + 60s BFF poll → `/analytics/anomalies`; spike/dip chips, z + baseline). e2e `analytics-anomaly-alert` **1/1** (new anomaly → notification to a monitoring:read holder; re-scan deduped). Suite **62 suites / 442 tests**, zero regressions; `tsc`/eslint clean; web `tsc`/`lint`/`build` green. **ADR-0066** covers P4.8 a–b. **Flink deferred (non-k8s/headless).** **P4.8 closed — and Horizon P4 complete** (P4.4 Mobile deferred). `apps/api/src/modules/analytics/anomaly-alert.service.ts`, `apps/web/src/app/dashboard/anomalies-widget.tsx`.

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
