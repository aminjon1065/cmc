import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// Load .env.test (and .env as a fallback) so test env vars are visible
// when this config is read by the Playwright CLI.
const apiRoot = resolve(__dirname, "../api");
loadDotenv({ path: resolve(apiRoot, ".env.test") });
loadDotenv({ path: resolve(apiRoot, ".env") });
loadDotenv({ path: resolve(__dirname, ".env") });

// Centralised env that both spawned subprocesses (api, web) inherit.
// Pinning these here means all four colours of "where do values come
// from" (Playwright, dotenv, process.env, CI workflow) converge here.
const childEnv = {
  // --- DB (cmc_test) ---
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://cmc_app:cmc_app_dev_password_change_me@localhost:5432/cmc_test",
  DATABASE_OWNER_URL:
    process.env.DATABASE_OWNER_URL ??
    "postgresql://cmc:cmc_dev_password_change_me@localhost:5432/cmc_test",
  // --- Redis / S3 (validator-required, not actually used in web e2e) ---
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "cmc-admin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "cmc_dev_minio_change_me",
  S3_BUCKET_FILES: process.env.S3_BUCKET_FILES ?? "cmc-files",
  S3_FORCE_PATH_STYLE: "true",
  // --- API auth ---
  JWT_SECRET:
    process.env.JWT_SECRET ??
    "playwright-test-jwt-secret-must-be-at-least-32-chars",
  JWT_ACCESS_TTL: "15m",
  JWT_REFRESH_TTL_SEC: "2592000",
  JWT_ISSUER: "cmc",
  // --- Documents limits ---
  DOCUMENTS_MAX_UPLOAD_BYTES: "104857600",
  DOCUMENTS_UPLOAD_URL_TTL_SEC: "300",
  DOCUMENTS_DOWNLOAD_URL_TTL_SEC: "300",
  // --- Misc API ---
  PORT: "3001",
  CORS_ORIGINS: "http://localhost:3000",
  NODE_ENV: "production",
  // --- Web ---
  AUTH_SECRET:
    process.env.AUTH_SECRET ?? "playwright-auth-secret-test-key-change",
  AUTH_TRUST_HOST: "true",
  API_BASE_URL: "http://localhost:3001",
  NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
  // Seed values are validator-required even though we provision
  // fixtures directly via DB.
  SEED_TENANT_SLUG: "playwright-default",
  SEED_TENANT_NAME: "Playwright Default",
  SEED_ADMIN_EMAIL: "admin@playwright.local",
  SEED_ADMIN_PASSWORD: "playwright_pwd_min8",
  SEED_ADMIN_NAME: "Playwright Admin",
};

export default defineConfig({
  testDir: "./tests/e2e",
  // Tests share the cmc_test DB and create unique resources per test;
  // serial keeps assertions stable without per-worker schema isolation.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  globalSetup: resolve(__dirname, "tests/e2e/global-setup.ts"),

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    video: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Both servers start on demand. `reuseExistingServer` lets a developer
  // run `pnpm dev` in another terminal and re-run tests without restart;
  // CI always starts fresh.
  webServer: [
    {
      command: "node dist/main.js",
      cwd: resolve(__dirname, "../api"),
      url: "http://localhost:3001/health",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    },
    {
      command: "node node_modules/next/dist/bin/next start --port 3000",
      cwd: __dirname,
      url: "http://localhost:3000/login",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    },
  ],
});
