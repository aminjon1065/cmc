import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { AppModule } from "../../src/app.module";
import { HttpExceptionFilter } from "../../src/common/filters/http-exception.filter";

/**
 * Build a NestJS application configured exactly the way `main.ts`
 * configures it — same global pipe, same exception filter, same shutdown
 * hooks. Tests get a real app, not a partial one.
 *
 * Caller is responsible for `app.close()` in afterAll.
 */
export async function buildTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  // Logger toggleable via TEST_LOG=1 — silent by default to keep test
  // output readable, available when chasing a 500.
  const app = moduleRef.createNestApplication({
    logger: process.env.TEST_LOG ? ["error", "warn", "log"] : false,
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
