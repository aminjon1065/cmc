import { z } from "zod";

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
