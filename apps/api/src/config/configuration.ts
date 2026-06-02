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

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_FILES: z.string().min(1),
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
  // overridden in any real deployment (and moves to Vault at P2.14). Validated
  // to decode to exactly 32 bytes so a short/garbage key fails fast at boot.
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
