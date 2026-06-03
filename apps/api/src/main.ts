// OTEL tracing MUST be the first import: its auto-instrumentations patch
// http / express / @nestjs/core / @aws-sdk / ioredis at require time, so
// it has to run before any of those modules are loaded below. The module
// loads dotenv and starts the SDK as an import side-effect (P0.6 / ADR-0013).
import "./tracing";

import "reflect-metadata";
// Load .env before any code reads process.env. Without this, the validation
// in main.ts (which runs before NestJS's ConfigModule) sees empty env vars.
import { config as loadDotenv } from "dotenv";
loadDotenv();

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger, RequestMethod, ValidationPipe } from "@nestjs/common";
import { Logger as PinoLogger } from "nestjs-pino";
import { loadConfig } from "./config/configuration";
import { loadVaultSecrets } from "./config/vault-secrets";
import {
  loadVaultDbCredentials,
  renewVaultLease,
} from "./config/vault-db-credentials";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";

// NOTE: AppModule (and the openapi helpers it transitively reaches) are imported
// DYNAMICALLY inside bootstrap(), AFTER loadVaultSecrets(). `ConfigModule.forRoot`
// validates process.env at module-IMPORT time, so importing AppModule statically
// here would validate before the Vault overlay runs (P2.14 / ADR-0044).

async function bootstrap() {
  // P2.14 / ADR-0044: when VAULT_ENABLED, pull secrets from Vault and overlay
  // them into process.env BEFORE anything validates — so MFA_ENC_KEY (and future
  // secrets) come from Vault while the rest of the app reads config unchanged.
  // No-op (pure-env fallback) when disabled. Runs after dotenv (Vault wins over
  // .env) and before the AppModule import below (whose ConfigModule.forRoot
  // validates process.env at import time).
  await loadVaultSecrets();

  // P4.7b / ADR-0065: when VAULT_DB_CREDS_ENABLED, lease short-lived Postgres
  // credentials from Vault's DB secrets engine and swap them into DATABASE_URL
  // (host/db kept) BEFORE validation. A background renewer keeps the lease alive
  // at ~half its TTL. No-op (static DATABASE_URL) when disabled.
  const dbCreds = await loadVaultDbCredentials();
  if (dbCreds.enabled && dbCreds.leaseId && dbCreds.leaseDuration > 0) {
    const leaseId = dbCreds.leaseId;
    const everyMs = Math.max(Math.floor(dbCreds.leaseDuration / 2), 30) * 1000;
    const renewer = setInterval(() => {
      void renewVaultLease(leaseId).catch((err) =>
        new Logger("VaultDbCreds").error(
          `lease renew failed: ${(err as Error).message}`,
        ),
      );
    }, everyMs);
    renewer.unref?.();
  }

  const config = loadConfig();

  // Dynamic import: must follow loadVaultSecrets() (see the import-time note up
  // top). Importing here is safe — the Vault overlay has already run.
  const { AppModule } = await import("./app.module");
  const { OpenApiService } = await import("./modules/openapi/openapi.service");
  const { buildOpenApiDocument } = await import(
    "./modules/openapi/build-openapi-document"
  );

  // `bufferLogs: true` — Nest queues pre-`useLogger` log lines (its own
  // bootstrap chatter) until pino is wired below, then replays them
  // through pino. Without this, bootstrap logs go to the default Nest
  // logger and the very first request's log entries land in a different
  // format from everything that follows.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Use nestjs-pino as the platform logger. Every `new Logger("Foo")`
  // throughout the codebase pipes through pino transparently — JSON in
  // prod, pino-pretty in dev. Configuration lives in
  // `common/logging/pino-options.ts`.
  app.useLogger(app.get(PinoLogger));

  // Trust X-Forwarded-* headers ONLY from private networks (loopback +
  // RFC1918 + link-local). Required for the per-IP rate limit (P0.1) to
  // see the real client IP once a reverse proxy lands at P0.9 — and safe
  // before that because no proxy means no forwarded header to trust.
  // Refusing to trust *arbitrary* upstreams closes the door on attackers
  // spoofing X-Forwarded-For to bypass the per-IP limit.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
    // Expose X-Request-Id so the browser / web app can surface it in
    // user-facing error toasts and correlate with our logs / audit.
    exposedHeaders: ["X-Request-Id"],
  });

  // Version every domain route under `/v1` (ToR §11.6 — lock the contract
  // before external consumers exist; ADR-0027). Operational endpoints are
  // deliberately EXCLUDED and stay at their root paths: orchestrator probes
  // hit `/health*` and Prometheus scrapes `/metrics` with hardcoded paths —
  // versioning those would silently break the obs stack (P1.7/P1.8) and any
  // k8s liveness/readiness wiring (P0.8).
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
      { path: "health/deep", method: RequestMethod.GET },
      { path: "metrics", method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  // Build the OpenAPI document once at boot (P1.10 / ADR-0028) and stash it in
  // OpenApiService for the gated GET /v1/openapi.json controller. Routes are
  // already registered (NestFactory.create ran the module graph), so the
  // generator sees the full surface. Gated by config so prod can omit it.
  if (config.OPENAPI_ENABLED) {
    app.get(OpenApiService).setDocument(buildOpenApiDocument(app));
    Logger.log(
      "OpenAPI document generated → GET /v1/openapi.json (tenant:manage)",
      "Bootstrap",
    );
  }

  app.enableShutdownHooks();

  await app.listen(config.PORT);
  Logger.log(
    `🚀 API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`,
    "Bootstrap",
  );
}

bootstrap().catch((err) => {
  console.error("Failed to bootstrap API:", err);
  process.exit(1);
});
