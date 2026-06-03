import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";
import { IMPORT_QUEUE, type ImportQueue } from "../../src/modules/imports/import.queue";

/**
 * LIVE SMOKE (not part of the default suite — `.live-smoke.ts`, excluded by the
 * `.e2e-spec.ts` testRegex). The default e2e drives `ImportService.runJob`
 * directly (queue is noop in test); THIS exercises the real BullMQ seam end to
 * end. Run with real Redis + MinIO + Postgres up:
 *
 *   cd apps/api && IMPORTS_ENABLED=true NODE_ENV=development \
 *     NODE_OPTIONS=--experimental-vm-modules npx jest --config test/jest-e2e.config.js \
 *     --testRegex 'imports-worker\.live-smoke\.ts$'
 *
 * NODE_ENV=development un-gates the worker (`isTest` skip); IMPORTS_ENABLED=true
 * wires the real queue. HTTP create → BullMQ enqueue → worker → runJob →
 * partial-commit + quarantine, all against real infra.
 */
describe("LIVE: import worker over real BullMQ", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let storage: StorageService;
  let bucket: string;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    storage = app.get(StorageService);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES")!;
    await truncateAll(sql, redis);
    const { user } = await createTenantWithAdmin(sql);
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("processes a CSV import through the real queue", async () => {
    const queue = app.get<ImportQueue>(IMPORT_QUEUE);
    expect(queue.active).toBe(true); // guard: real BullMQ wired (IMPORTS_ENABLED)

    const key = `imports/${randomUUID()}.csv`;
    await storage.putObject({
      bucket,
      key,
      body: Buffer.from(
        [
          "severity,type,region,summary,occurredAt",
          "4,storm,Sughd,Heavy storm,2026-03-01T00:00:00.000Z",
          "9,bad,X,out-of-range,2026-03-02T00:00:00.000Z", // quarantined
        ].join("\n"),
        "utf8",
      ),
      contentType: "text/csv",
    });

    const created = await authed(app, token)
      .post("/v1/imports")
      .send({ kind: "csv_incidents", sourceKey: key })
      .expect(201);
    const id = created.body.job.id as string;

    let job: { status: string; insertedRows: number; failedRows: number } | null =
      null;
    for (let i = 0; i < 40; i++) {
      const r = await authed(app, token).get(`/v1/imports/${id}`).expect(200);
      job = r.body.job;
      if (job!.status === "completed" || job!.status === "failed") break;
      await new Promise((res) => setTimeout(res, 250));
    }

    expect(job!.status).toBe("completed");
    expect(job!.insertedRows).toBe(1);
    expect(job!.failedRows).toBe(1);
    console.log("LIVE import worker OK:", JSON.stringify(job));
  }, 30_000);
});
