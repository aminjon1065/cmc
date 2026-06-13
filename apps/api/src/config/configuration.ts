import { z } from "zod";

/**
 * Coerce an empty-string env var to `undefined` before validation.
 * Compose / k8s commonly pass `VAR=` (empty) to mean "unset"; without this an
 * empty value would hit the wrapped validator (e.g. `.url()`) and crash boot.
 */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema,
  );
}

/**
 * Centralised env-driven configuration. Validated at startup so the process
 * fails fast on misconfiguration rather than at first use.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["error", "warn", "info", "debug", "verbose"])
    .default("info"),

  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().url(),
  /** Owner connection (superuser) — only used by the seed script. */
  DATABASE_OWNER_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  // --- Secrets / Vault (P2.14 / ADR-0044) ---
  // When enabled, an in-process loader (`src/config/vault-secrets.ts`) fetches a
  // KV v2 secret from Vault at boot and overlays its keys into process.env
  // BEFORE this schema validates — so secrets (today MFA_ENC_KEY) come from Vault
  // while every ConfigService.get(...) stays unchanged. Off by default → pure
  // env fallback (dev/test/CI need no Vault). VAULT_TOKEN is the dev-mode root
  // token locally; a scoped AppRole/k8s-auth token in prod. The dynamic
  // database-secrets engine + Agent sidecar are the documented follow-on.
  VAULT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  VAULT_ADDR: z.string().url().default("http://localhost:8200"),
  VAULT_TOKEN: emptyAsUndefined(z.string().optional()),
  VAULT_KV_MOUNT: z.string().default("secret"),
  VAULT_SECRET_PATH: z.string().default("cmc/api"),
  // P4.7a: production auth method. `token` (dev: VAULT_TOKEN root/dev token) or
  // `approle` (prod: VAULT_ROLE_ID + VAULT_SECRET_ID → a short-lived client
  // token via the AppRole login). The loader resolves a token via the chosen
  // method, then reads KV v2 exactly as before.
  VAULT_AUTH_METHOD: z.enum(["token", "approle"]).default("token"),
  VAULT_ROLE_ID: emptyAsUndefined(z.string().optional()),
  VAULT_SECRET_ID: emptyAsUndefined(z.string().optional()),
  VAULT_APPROLE_MOUNT: z.string().default("approle"),
  // P4.7b: dynamic database credentials via the Vault DB secrets engine. When
  // enabled, the boot loader leases short-lived Postgres creds from
  // `{mount}/creds/{role}` and swaps them into DATABASE_URL's userinfo (host/db
  // kept). Off by default → static DATABASE_URL (backward-compatible).
  VAULT_DB_CREDS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  VAULT_DB_MOUNT: z.string().default("database"),
  VAULT_DB_ROLE: emptyAsUndefined(z.string().optional()),

  // --- Durable workflows / Temporal (P3.1 / ADR-0045) ---
  // Code-defined durable workflows (first: per-case SLA-escalation timers,
  // replacing cron). ENABLED gates BOTH the in-process worker (polls the task
  // queue, runs workflow + activity code) AND the real client (the gated seam
  // that starts/cancels workflows). Off by default → a Noop client + no worker,
  // so dev/test/CI need no Temporal (the gated-seam convention used for NATS/
  // ClickHouse/BullMQ/Vault). `@temporalio/*` is dynamic-imported, never in jest.
  TEMPORAL_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("cmc-main"),

  // --- Incident-response workflow (P3.2 / ADR-0046) ---
  // The Temporal incident-response workflow auto-starts for incidents at/above
  // this severity (1 = SEV-1; default 2 → SEV-1 + SEV-2). It pages the
  // assignee + reporter, reminds every REMINDER_INTERVAL while the incident is
  // unacknowledged (still "reported"), and escalates to incident:resolve holders
  // if still unacknowledged after ACK_SLA. All gated by TEMPORAL_ENABLED (off →
  // the scheduler is a noop). Durations are seconds.
  INCIDENT_RESPONSE_SEVERITY_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2),
  INCIDENT_ACK_SLA_SEC: z.coerce.number().int().positive().default(900),
  INCIDENT_REMINDER_INTERVAL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(300),

  // --- Search engine / OpenSearch (P3.6 / ADR-0051) ---
  // When enabled, documents are indexed into OpenSearch (best-effort) and the
  // OpenSearch-backed search path is available. Off by default → a noop index +
  // Postgres FTS remains the search (the gated-lazy-seam pattern; the driver is
  // dynamic-imported, never in jest). INDEX_PREFIX namespaces indices per env.
  OPENSEARCH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  OPENSEARCH_URL: z.string().url().default("http://localhost:9200"),
  OPENSEARCH_INDEX_PREFIX: z.string().default("cmc"),

  // --- API keys / external API quota (P3.9 / ADR-0054) ---
  // Fixed-window Redis quota for API-key requests: per individual key + per
  // tenant aggregate. JWT (interactive) requests are unaffected.
  API_KEY_RATE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  API_KEY_RATE_LIMIT: z.coerce.number().int().positive().default(120),
  API_KEY_TENANT_RATE_LIMIT: z.coerce.number().int().positive().default(600),

  // --- Event plane / NATS JetStream (P2.1 / ADR-0031) ---
  // The outbox relay publishes to NATS; consumers subscribe. Used by the relay
  // (P2.1b) — the outbox write side (P2.1a) is pure Postgres and needs no
  // connection. Default points at the dev compose NATS.
  NATS_URL: z.string().url().default("nats://localhost:4222"),
  // Gate the relay's NATS connection + background interval. Off by default so
  // dev/test/CI don't require a running NATS; the outbox still fills (the relay
  // simply doesn't drain it). Set true wherever a NATS is reachable.
  NATS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  NATS_STREAM: z.string().default("CMC_EVENTS"),
  EVENTS_RELAY_INTERVAL_SEC: z.coerce.number().int().min(0).default(5),
  EVENTS_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(200),

  // --- Realtime / WebSocket gateway (P2.3 / ADR-0035) ---
  // The realtime plane pushes events to browsers over a WebSocket at
  // `/v1/realtime`. ENABLED gates the gateway hooking the HTTP upgrade event —
  // off means the endpoint simply isn't there (no socket accepts). On by
  // default (single-process; splits to apps/realtime at scale). MAX_SUBSCRIPTIONS
  // caps per-connection subscriptions to bound memory against a hostile client.
  REALTIME_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  REALTIME_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(100),

  // --- ClickHouse — analytical store (P2.5 / ADR-0033) ---
  // The incident projection consumer (P2.5b) writes events to ClickHouse for
  // analytics. Gated by CLICKHOUSE_ENABLED so dev/test/CI don't require it.
  // @clickhouse/client talks the HTTP interface (8123).
  CLICKHOUSE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  CLICKHOUSE_URL: z.string().url().default("http://localhost:8123"),
  CLICKHOUSE_DATABASE: z.string().default("cmc"),
  CLICKHOUSE_USER: z.string().default("cmc"),
  CLICKHOUSE_PASSWORD: z.string().default("cmc_dev_clickhouse_change_me"),
  // Audit→ClickHouse projection (P2.2 / ADR-0034). Cursor-tail of audit_log.
  // Interval gates the background worker; flush always runs. 0 disables timer.
  AUDIT_PROJECTION_INTERVAL_SEC: z.coerce.number().int().min(0).default(15),
  AUDIT_PROJECTION_BATCH_SIZE: z.coerce.number().int().positive().default(1000),

  // P4.8b: proactive realtime-anomaly detector. When enabled (and ClickHouse is
  // active), a background scan flags incident-volume anomalies and notifies
  // `monitoring:read` holders (once per tenant/day/direction). Off by default →
  // the /v1/analytics/anomalies endpoint still works on-demand.
  ANALYTICS_ANOMALY_DETECTOR_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  ANALYTICS_ANOMALY_INTERVAL_SEC: z.coerce.number().int().min(0).default(300),

  // P5.1: self-hosted LLM gateway. Gated by LLM_ENABLED → a real OpenAI-compatible
  // client (vLLM / Ollama / llama.cpp at LLM_BASE_URL) vs a noop. Per-tenant
  // rate-limit; metadata-only audit unless LLM_LOG_PROMPTS (raw prompts/responses).
  LLM_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  LLM_BASE_URL: z.string().url().default("http://localhost:8000"),
  LLM_API_KEY: emptyAsUndefined(z.string().optional()),
  LLM_MODEL: z.string().default("llama-3.1-8b-instruct"),
  LLM_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LLM_LOG_PROMPTS: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  /** Embeddings model on the same OpenAI-compatible gateway (P5.2). */
  LLM_EMBED_MODEL: z.string().default("bge-m3"),

  // P5.2: vector pipeline. Effective gate is VECTOR_ENABLED AND the LLM provider
  // being active → documents are embedded + stored (Postgres) for semantic
  // search (P5.3). Default on, so enabling the LLM enables embedding.
  VECTOR_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),

  // P5.4: RAG. Reuses the LLM gateway (P5.1) + hybrid retrieval (P5.3); no
  // separate enable flag — RAG is available whenever the LLM provider is active.
  // TOP_K sources are retrieved (permission-filtered); their text is assembled
  // into a context capped at CONTEXT_CHAR_BUDGET characters.
  RAG_TOP_K: z.coerce.number().int().positive().max(20).default(5),
  RAG_CONTEXT_CHAR_BUDGET: z.coerce.number().int().positive().default(6000),

  // P5.6: document intelligence (text extraction / OCR). Gated seam — when off
  // (dev/test/CI default), the extractor is a no-op. The real extractor (PDF
  // text-layer + Tesseract OCR for scans) is a CPU/sovereign live boundary: its
  // libs (pdf-parse, tesseract.js) are installed on the serving host only.
  // OCR_LANG is Tesseract's language pack ("eng+rus" for the TJ КЧС by default).
  DOC_EXTRACT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  DOC_EXTRACT_MAX_CHARS: z.coerce.number().int().positive().default(200_000),
  DOC_EXTRACT_OCR_LANG: z.string().default("eng+rus"),

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_FILES: z.string().min(1),

  // P5.DR: single-site disaster-recovery backup-freshness check (over the P0.5
  // nightly dumps in the backups bucket). `fresh` = newest dump younger than the
  // RPO window; powers GET /v1/ops/backups/status (+ a future Prometheus alert).
  BACKUP_S3_BUCKET: z.string().min(1).default("cmc-backups"),
  BACKUP_RPO_HOURS: z.coerce.number().int().positive().default(36),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),

  // --- Documents module ---
  DOCUMENTS_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  DOCUMENTS_UPLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(300),
  // Multipart upload (P2.12 / ADR-0042). Part size for resumable large-file
  // uploads; S3 requires non-final parts ≥ 5 MiB. Default 8 MiB.
  DOCUMENTS_MULTIPART_PART_SIZE: z.coerce
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  DOCUMENTS_DOWNLOAD_URL_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  // Versioning (P3.4 / ADR-0049): a version's SHA-256 content_hash is computed
  // server-side by reading the object at finalize — only when its size is at/under
  // this cap, to bound API memory (the read buffers the whole object). Larger
  // objects get a null hash. Default 50 MiB.
  DOCUMENTS_HASH_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  // Retention sweeper (P3.5 / ADR-0050): a daily cron soft-deletes documents past
  // their (inherited) retention, skipping legal-held ones. ENABLED gates the cron
  // only — the manual /documents/retention/sweep endpoint always runs. Off by
  // default so an automated delete never surprises a deploy.
  RETENTION_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  // --- Preview generation (P2.13 / ADR-0043) ---
  // BullMQ worker generates thumbnails/posters on finalize. ENABLED gates the
  // queue connection + worker (off → no preview jobs; finalize unaffected).
  // Image previews use sharp (bundled); PDF/video/audio need poppler/ffmpeg in
  // the runtime image (skipped with a log until present).
  PREVIEWS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  PREVIEW_MAX_DIM: z.coerce.number().int().positive().default(512),

  // --- Media management (P4.5 / ADR-0063) ---
  // Gated BullMQ worker transcodes an uploaded video document to HLS (ffmpeg,
  // dynamic-imported) → S3. Off by default (jobs are created but not processed);
  // ffmpeg must be in the worker image. The browser streams via the BFF proxy.
  MEDIA_TRANSCODE_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  MEDIA_HLS_SEGMENT_SECONDS: z.coerce.number().int().positive().default(6),
  // Optional TTF/OTF path for the ffmpeg `drawtext` watermark (P4.5c). Empty →
  // rely on the image's fontconfig default (a font must still be present).
  MEDIA_WATERMARK_FONT: z.string().default(""),

  // --- Bulk data import (P3.11 / ADR-0056) ---
  // BullMQ worker parses an uploaded file and bulk-inserts into a target domain
  // (CSV→incidents, GeoJSON→GIS), quarantining bad rows. ENABLED gates the queue
  // connection + worker (off → import jobs are created but not processed). The
  // service path is unaffected by the flag (tests drive it directly).
  IMPORTS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // Hard cap on rows processed per job (protects the worker from huge files).
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(50000),

  // --- Realtime collaboration (Hocuspocus / Yjs) (P4.1 / ADR-0060) ---
  // ENABLED gates the dedicated Hocuspocus WebSocket server (separate from the
  // P2.3 realtime gateway). Off by default + never in jest; the persistence
  // service (CollabService) is tested directly. PORT is the server's listen port.
  HOCUSPOCUS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  HOCUSPOCUS_PORT: z.coerce.number().int().positive().default(3002),
  // Debounce (ms) before snapshotting the live Y.Doc back to the domain row.
  HOCUSPOCUS_SNAPSHOT_DEBOUNCE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2000),
  // Public WS URL the browser opens for collaboration (behind Caddy in prod,
  // e.g. wss://app.example/collab → api:3002; direct in dev).
  HOCUSPOCUS_PUBLIC_URL: z.string().default("ws://localhost:3002"),
  // Lifetime of a single-use collaboration connection ticket. Short: it only
  // needs to survive from BFF mint to WS handshake (the client fetches a fresh
  // one per (re)connect).
  HOCUSPOCUS_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  // --- Auth / JWT ---
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30), // 30 days
  JWT_ISSUER: z.string().default("cmc"),

  // --- Auth rate limits (P0.1 / ADR-0009) ---
  // Per-IP and per-email fixed-window counters guarding POST /auth/login
  // and POST /auth/refresh from online brute-force. Defaults are
  // OWASP-aligned; a tenant under a stricter policy can override.
  AUTH_LOGIN_IP_LIMIT: z.coerce.number().int().positive().default(30),
  AUTH_LOGIN_IP_WINDOW_SEC: z.coerce.number().int().positive().default(300),
  AUTH_LOGIN_EMAIL_LIMIT: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_EMAIL_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  AUTH_REFRESH_IP_LIMIT: z.coerce.number().int().positive().default(60),
  AUTH_REFRESH_IP_WINDOW_SEC: z.coerce.number().int().positive().default(300),

  // --- Session-active cache (P0.4 / ADR-0011) ---
  // TTL for the Redis-backed "is this sid active?" cache that
  // short-circuits the per-request DB lookup in
  // `TenantContextMiddleware`. Recommended: set equal (or close) to
  // the access-token lifetime — a failed cache DEL then adds zero
  // exposure beyond the JWT's natural expiry. Default 900 s ≈ 15 min,
  // matching the JWT_ACCESS_TTL default.
  SESSION_CACHE_TTL_SEC: z.coerce.number().int().positive().default(900),

  // --- Observability / OpenTelemetry (P0.6 / ADR-0013) ---
  // NOTE: these are read directly from process.env by `src/tracing.ts` at
  // process start — before Nest's ConfigModule loads — because the OTEL
  // auto-instrumentations must patch http/express/aws-sdk/ioredis before
  // those modules are imported. They are mirrored here purely for
  // validation + documentation (and so anything that wants them at
  // runtime can read them via ConfigService).
  //
  // Tracing is ON by default; the exporter is what's gated: set an OTLP
  // endpoint to ship spans (P1.8 / Tempo), or OTEL_TRACES_CONSOLE=true to
  // print them. With neither, spans are still created (trace_id flows into
  // logs + audit, W3C context propagates) but nothing is exported.
  OTEL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  OTEL_SERVICE_NAME: z.string().default("cmc-api"),
  OTEL_SERVICE_VERSION: z.string().default("0.0.0"),
  // Treat an empty string as unset (compose/k8s often pass `VAR=` to mean
  // "no value") so an explicitly-blank endpoint doesn't fail the url() check
  // and crash boot. `undefined` and "" both mean "no collector".
  OTEL_EXPORTER_OTLP_ENDPOINT: emptyAsUndefined(z.string().url().optional()),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: emptyAsUndefined(
    z.string().url().optional(),
  ),
  OTEL_TRACES_CONSOLE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  // --- Log aggregation / Loki (P1.7 / ADR-0025) ---
  // When set, the API ALSO ships its structured pino logs to Loki (the
  // pino-loki transport) on top of stdout — so the host-run API's logs land
  // in Grafana, queryable by request_id/tenant. Dev: http://localhost:3100
  // (the obs-compose Loki). Unset (or empty) → stdout only, behaviour
  // unchanged. Gated exactly like the OTEL exporter.
  LOKI_URL: emptyAsUndefined(z.string().url().optional()),

  // --- Metrics / Prometheus (P0.7 / ADR-0014) ---
  // When true, the API exposes GET /metrics (prom-client) and records the
  // HTTP RED histogram + DB transaction gauges. The endpoint itself is
  // always mounted; this flag gates recording so it can be silenced
  // without removing the route. Default on.
  METRICS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // --- OpenAPI / API docs (P1.10 / ADR-0028) ---
  // When true, the API builds the OpenAPI 3.0 document at boot and serves it at
  // GET /v1/openapi.json — gated behind a valid session + the `tenant:manage`
  // permission (it describes the full admin surface, so it is NOT anonymous).
  // Set false to omit the document entirely (the route then 404s). The build
  // cost is one-time at startup; unset/false → zero overhead.
  OPENAPI_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  // --- Audit hash chain (P1.11 / ADR-0029) ---
  // Tamper-EVIDENCE on top of the append-only audit log. When enabled, an async
  // sealer fills each row's prev/this SHA256 hash within a per-(tenant, day)
  // chain. AUDIT_SEAL_INTERVAL_SEC is the background sealer's cadence in seconds;
  // 0 disables the timer (rows still seal on demand via the admin endpoint and
  // in tests). Disabling AUDIT_CHAIN_ENABLED leaves rows unsealed (append-only
  // still holds via RLS) — the chain can be backfilled later.
  AUDIT_CHAIN_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  AUDIT_SEAL_INTERVAL_SEC: z.coerce.number().int().min(0).default(60),

  // --- Audit Merkle anchoring (P1.11b / ADR-0029) ---
  // A daily cron Merkle-roots each sealed (tenant, day) chain and writes the
  // root to object storage under Object Lock (WORM) — the tamper-proof anchor.
  // The bucket is created with object-lock enabled on first use. LOCK_MODE:
  // GOVERNANCE (privileged users can override with BypassGovernanceRetention —
  // dev/test default) or COMPLIANCE (immutable until retention expires, even
  // for root — recommended in prod). RETENTION_DAYS bounds the WORM window.
  AUDIT_ANCHOR_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  AUDIT_ANCHOR_BUCKET: z.string().default("cmc-audit-anchors"),
  AUDIT_ANCHOR_LOCK_MODE: z.enum(["GOVERNANCE", "COMPLIANCE"]).default(
    "GOVERNANCE",
  ),
  AUDIT_ANCHOR_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(3650),

  // --- Audit SIEM export (P1.12 / ADR-0030) ---
  // A worker tail-reads the (tamper-evident) audit log by `seq` cursor and ships
  // each row as RFC 5424 syslog or CEF to a configurable sink. ENABLED gates the
  // background interval only — a manual flush (endpoint / cron) always runs. The
  // default sink is `noop` (format-but-discard) so nothing is emitted until a
  // SIEM destination is configured. Delivery is at-least-once (the SIEM dedups
  // on the row id), so a cursor that lags re-ships, never gaps.
  AUDIT_EXPORT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  AUDIT_EXPORT_FORMAT: z.enum(["rfc5424", "cef"]).default("rfc5424"),
  AUDIT_EXPORT_TRANSPORT: z
    .enum(["noop", "stdout", "file", "tcp"])
    .default("noop"),
  AUDIT_EXPORT_FILE: z.string().default("./audit-export.log"),
  AUDIT_EXPORT_TCP_HOST: z.string().default("localhost"),
  AUDIT_EXPORT_TCP_PORT: z.coerce.number().int().positive().default(514),
  AUDIT_EXPORT_INTERVAL_SEC: z.coerce.number().int().min(0).default(30),
  AUDIT_EXPORT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  // syslog HOSTNAME field; defaults to os.hostname() when unset.
  AUDIT_EXPORT_HOSTNAME: emptyAsUndefined(z.string().optional()),

  // --- Health probes (P0.8 / ADR-0015) ---
  // Per-dependency timeout for the /health/ready + /health/deep probes
  // (Postgres / Redis / MinIO). Bounds each probe so a hung dependency
  // can't hang the endpoint and make an orchestrator think the whole API
  // is wedged. Default 2s.
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  // --- Branding (P0.11 / ADR-0018) ---
  // The tenant whose branding the anonymous / pre-auth pages (login, root
  // metadata) resolve. Defaults to the seed tenant slug. A logged-in request
  // always gets its own tenant's branding regardless of this.
  DEFAULT_TENANT_SLUG: z.string().default("default"),

  // --- RBAC (P1.1 / ADR-0019) ---
  // TTL for the Redis-cached per-user permission set. Bounds staleness if an
  // invalidation DEL is missed. Default 300s.
  RBAC_PERM_CACHE_TTL_SEC: z.coerce.number().int().positive().default(300),

  // --- MFA / TOTP (P1.2 / ADR-0020) ---
  // 32-byte (base64) key that encrypts TOTP secrets at rest (AES-256-GCM).
  // The dev default is a FIXED, PUBLIC key — fine for local/test, MUST be
  // overridden in any real deployment. Sourced from Vault when VAULT_ENABLED
  // (P2.14 / ADR-0044): the in-process loader overlays it into process.env
  // before this validates. Validated to decode to exactly 32 bytes so a
  // short/garbage key fails fast at boot.
  MFA_ENC_KEY: z
    .string()
    .default("ZGV2LW1mYS1lbmNyeXB0aW9uLWtleS0zMmJ5dGVzISE=")
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "MFA_ENC_KEY must be 32 bytes when base64-decoded",
    }),
  // Lifetime of the short-lived mfa_token issued between password and the
  // TOTP second step. Default 300s (5 min).
  MFA_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
  // otpauth issuer label shown in the authenticator app.
  MFA_ISSUER: z.string().default("CMC"),
  // How many one-time backup codes to generate on enrolment.
  MFA_BACKUP_CODE_COUNT: z.coerce.number().int().positive().default(10),

  // --- Password reset (P1.3 / ADR-0021) ---
  // Lifetime of a single-use reset token. Short by design: a leaked token is
  // only useful within this window. Default 3600s (1h).
  PASSWORD_RESET_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),
  // Base URL the self-service flow embeds the token into when building the
  // reset link the notifier delivers (dev logs it; SMTP sends it at P1.6).
  // The token is appended as `?token=...`.
  PASSWORD_RESET_URL_BASE: z
    .string()
    .url()
    .default("http://localhost:3000/reset-password"),
  // Rate limits for the public reset endpoints. The per-email bucket is the
  // anti-abuse control: each forgot-password triggers a notification, so it's
  // stricter than login. Per-IP guards the token-completion brute force.
  PASSWORD_RESET_IP_LIMIT: z.coerce.number().int().positive().default(10),
  PASSWORD_RESET_IP_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  PASSWORD_RESET_EMAIL_LIMIT: z.coerce.number().int().positive().default(3),
  PASSWORD_RESET_EMAIL_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),

  // --- Email / SMTP (P1.6c / ADR-0024) ---
  // When enabled, outgoing email goes through this SMTP server (Nodemailer).
  // Dev points at Mailpit (host=localhost, port=1025, no auth) — it catches
  // everything in a web UI. When disabled (or in prod without a host), the
  // MailService LOGS the message in dev and WARNS+DROPS in prod (so reset
  // links never hit prod stdout). `MAIL_FROM` is the envelope sender.
  MAIL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  MAIL_HOST: z.string().default("localhost"),
  MAIL_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_SECURE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  MAIL_USER: emptyAsUndefined(z.string().optional()),
  MAIL_PASS: emptyAsUndefined(z.string().optional()),
  MAIL_FROM: z.string().default("CMC <no-reply@cmc.local>"),
  // Absolute base the app builds links from in emails (notifications deep-link).
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  // --- Seed (only required when running `pnpm seed`) ---
  SEED_TENANT_SLUG: z.string().default("default"),
  SEED_TENANT_NAME: z.string().default("Default Tenant"),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@cmc.local"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("admin123456"),
  SEED_ADMIN_NAME: z.string().default("Platform Admin"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }
  return parsed.data;
}
