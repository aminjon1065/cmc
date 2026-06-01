import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Health probes (P0.8 / ADR-0015): liveness, readiness, deep.
 *
 * The readiness + deep assertions require the real dependencies
 * (Postgres, Redis, MinIO) to be reachable — they are, since the e2e
 * suite already runs against live infra. The `cmc-files` bucket exists
 * because `minio-init` creates it on infra bring-up.
 */
describe("Health", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let user: TestUser;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "health-test",
      email: "ops@health.test",
      password: "health_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- liveness ----------

  it("GET /health returns ok status (liveness, no deps touched)", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  // ---------- readiness ----------

  it("GET /health/ready returns 200 + every dependency up", async () => {
    const res = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(200);

    expect(res.body.status).toBe("ready");
    const names = (res.body.checks as { name: string; status: string }[])
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["minio", "postgres", "redis"]);
    for (const c of res.body.checks) {
      expect(c.status).toBe("up");
    }
  });

  it("GET /health/ready is anonymous (no token required)", async () => {
    // No Authorization header → still reachable (LBs have no token).
    await request(app.getHttpServer()).get("/health/ready").expect(200);
  });

  // ---------- deep ----------

  it("GET /health/deep requires authentication", async () => {
    await request(app.getHttpServer()).get("/health/deep").expect(401);
  });

  it("GET /health/deep returns per-dependency timings when authenticated", async () => {
    const { accessToken } = await loginAs(app, user);
    const res = await authed(app, accessToken).get("/health/deep").expect(200);

    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(Array.isArray(res.body.dependencies)).toBe(true);

    const deps = res.body.dependencies as {
      name: string;
      status: string;
      latencyMs: number;
      error?: string;
    }[];
    expect(deps.map((d) => d.name).sort()).toEqual([
      "minio",
      "postgres",
      "redis",
    ]);
    for (const d of deps) {
      expect(d.status).toBe("up");
      expect(typeof d.latencyMs).toBe("number");
      expect(d.latencyMs).toBeGreaterThanOrEqual(0);
      // up probes carry no error field
      expect(d.error).toBeUndefined();
    }
  });
});
