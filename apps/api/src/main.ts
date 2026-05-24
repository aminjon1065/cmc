import "reflect-metadata";
// Load .env before any code reads process.env. Without this, the validation
// in main.ts (which runs before NestJS's ConfigModule) sees empty env vars.
import { config as loadDotenv } from "dotenv";
loadDotenv();

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger, ValidationPipe } from "@nestjs/common";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";

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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

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
