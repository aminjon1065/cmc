import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Prometheus /metrics endpoint (P0.7 / ADR-0014).
 *
 * Asserts the operational contract: the endpoint exposes prom-format
 * text, Node defaults are present, the HTTP RED histogram increments with
 * a *normalised* route label (no high-cardinality ids), and the DB
 * transaction metrics move when a request touches Postgres.
 */
describe("Metrics endpoint", () => {
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
      tenantSlug: "metrics-test",
      email: "metrics@metrics.test",
      password: "metrics_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- exposition format ----------

  it("serves prom-format text with the prom-client content type", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("version=0.0.4");
    // Node default metrics are present (collectDefaultMetrics).
    expect(res.text).toContain("process_cpu_seconds_total");
    expect(res.text).toContain("nodejs_heap_size_used_bytes");
    // Our default label is applied.
    expect(res.text).toContain('service="cmc-api"');
  });

  it("declares the HTTP + DB metric families with HELP lines", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(res.text).toContain(
      "# HELP http_request_duration_seconds",
    );
    expect(res.text).toContain("# TYPE http_request_duration_seconds histogram");
    expect(res.text).toContain("# HELP cmc_db_transactions_in_flight");
    expect(res.text).toContain("# HELP cmc_db_transactions_total");
    expect(res.text).toContain("cmc_db_pool_max");
  });

  // ---------- RED histogram increments with a normalised route ----------

  it("records http_request_duration_seconds for a matched route with a pattern label", async () => {
    // Hit a real, matched route that touches the DB.
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);

    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    // The count series for POST /v1/auth/login must exist with status 200.
    // The route label carries the global `/v1` prefix (ADR-0027) — the RED
    // middleware reads `req.route.path`, which NestJS registers prefix-inclusive.
    const line = res.text
      .split("\n")
      .find(
        (l) =>
          l.startsWith("http_request_duration_seconds_count") &&
          l.includes('route="/v1/auth/login"') &&
          l.includes('method="POST"') &&
          l.includes('status_code="200"'),
      );
    expect(line).toBeDefined();
    // count >= 1
    const value = Number(line!.trim().split(/\s+/).pop());
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it("does NOT leak high-cardinality ids into the route label", async () => {
    // Hit a route with a UUID path param (DELETE /auth/sessions/:id).
    // Unauthenticated → 401, but it still matches the route pattern.
    const fakeId = "00000000-0000-4000-8000-000000000000";
    await request(app.getHttpServer())
      .delete(`/v1/auth/sessions/${fakeId}`)
      .expect(401);

    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    // The concrete UUID must never appear as a label value.
    expect(res.text).not.toContain(fakeId);
  });

  it("excludes /metrics and /health from the RED histogram", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
    await request(app.getHttpServer()).get("/metrics").expect(200);

    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(res.text).not.toContain('route="/health"');
    expect(res.text).not.toContain('route="/metrics"');
  });

  // ---------- DB transaction metrics ----------

  it("increments cmc_db_transactions_total after a DB-backed request", async () => {
    // login runs a privileged transaction.
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);

    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    const line = res.text
      .split("\n")
      .find(
        (l) =>
          l.startsWith("cmc_db_transactions_total") &&
          l.includes('scope="privileged"') &&
          l.includes('outcome="commit"'),
      );
    expect(line).toBeDefined();
    const value = Number(line!.trim().split(/\s+/).pop());
    expect(value).toBeGreaterThanOrEqual(1);
  });

  it("reports the configured DB pool max", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    const line = res.text
      .split("\n")
      .find((l) => l.startsWith("cmc_db_pool_max"));
    expect(line).toBeDefined();
    expect(Number(line!.trim().split(/\s+/).pop())).toBe(20);
  });
});
