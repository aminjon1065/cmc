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
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { OpenApiService } from "./modules/openapi/openapi.service";
import { buildOpenApiDocument } from "./modules/openapi/build-openapi-document";

async function bootstrap() {
  const config = loadConfig();

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
