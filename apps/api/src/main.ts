import "reflect-metadata";
// Load .env before any code reads process.env. Without this, the validation
// in main.ts (which runs before NestJS's ConfigModule) sees empty env vars.
import { config as loadDotenv } from "dotenv";
loadDotenv();

import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";

async function bootstrap() {
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, {
    logger:
      config.NODE_ENV === "production"
        ? ["error", "warn", "log"]
        : ["error", "warn", "log", "debug", "verbose"],
  });

  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
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
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap API:", err);
  process.exit(1);
});
