import "reflect-metadata";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module";
import { HttpExceptionFilter } from "../../src/common/filters/http-exception.filter";

/**
 * Build a NestJS application configured exactly the way `main.ts`
 * configures it — same trust-proxy posture, same global pipe, same
 * exception filter. Tests get a real app, not a partial one.
 *
 * The return type is `NestExpressApplication` (not the abstract
 * `INestApplication`) so callers can — like main.ts — touch the
 * underlying Express instance when needed. trust-proxy in particular
 * must be set via the concrete type.
 *
 * Caller is responsible for `app.close()` in afterAll.
 *
 * `configure` is an optional hook to tweak the testing module before compile —
 * e.g. `.overrideProvider(TOKEN).useValue(fake)` to swap a side-effecting
 * dependency (the P1.3 password-reset notifier capture uses this). Existing
 * callers pass nothing and get the production wiring unchanged.
 */
export async function buildTestApp(
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (configure) builder = configure(builder);
  const moduleRef = await builder.compile();

  // Logger toggleable via TEST_LOG=1 — silent by default to keep test
  // output readable, available when chasing a 500.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: process.env.TEST_LOG ? ["error", "warn", "log"] : false,
  });
  // Mirror main.ts: trust X-Forwarded-* only from private networks. The
  // per-IP rate-limit (P0.1) tests assert isolation across spoofed IPs,
  // which requires the loopback supertest connection to be in the
  // trusted set so forwarded headers are honoured.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // Mirror main.ts: version domain routes under /v1, leave /health* + /metrics
  // at root. Tests exercise the real prefixed routing (ADR-0027).
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
  await app.init();
  return app;
}
