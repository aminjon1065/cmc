import request from "supertest";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RequestContext + structured logging (P0.3 / ADR-0010) tests.
 *
 * The audit-row assertions are the load-bearing ones — they're the
 * regression on "future code that touches AuditService.record() keeps
 * the request_id flowing through to the database column."
 */
describe("Request context", () => {
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
      tenantSlug: "request-context-test",
      email: "alice@reqctx.test",
      password: "reqctx_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- header generation ----------

  it("generates a UUID v4 X-Request-Id when none is sent", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    const id = res.headers["x-request-id"];
    expect(id).toBeDefined();
    expect(UUID_RE.test(id!)).toBe(true);
  });

  it("honours a valid inbound X-Request-Id", async () => {
    const inbound = randomUUID();
    const res = await request(app.getHttpServer())
      .get("/health")
      .set("X-Request-Id", inbound)
      .expect(200);
    expect(res.headers["x-request-id"]).toBe(inbound);
  });

  it("rejects a malformed X-Request-Id and mints a fresh one", async () => {
    const res = await request(app.getHttpServer())
      .get("/health")
      .set("X-Request-Id", "not-a-uuid; injected=<script>")
      .expect(200);
    const id = res.headers["x-request-id"];
    expect(id).not.toBe("not-a-uuid; injected=<script>");
    expect(UUID_RE.test(id!)).toBe(true);
  });

  // ---------- response body ----------

  it("includes request_id in problem+json error bodies", async () => {
    const inbound = randomUUID();
    const res = await request(app.getHttpServer())
      .get("/v1/auth/me") // protected — no token → 401 via filter
      .set("X-Request-Id", inbound)
      .expect(401);
    expect(res.headers["x-request-id"]).toBe(inbound);
    expect(res.body.request_id).toBe(inbound);
  });

  // ---------- audit-log integration: success path ----------

  it("login success populates audit_log.request_id with the response's id", async () => {
    const inbound = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .set("X-Request-Id", inbound)
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(res.headers["x-request-id"]).toBe(inbound);

    const rows = await sql<{ request_id: string | null }[]>`
      SELECT request_id FROM audit_log
       WHERE action = 'user.login' AND outcome = 'success'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.request_id).toBe(inbound);
  });

  // ---------- audit-log integration: durable failure path ----------

  it("login failure (durable audit) populates request_id even when the request rolls back", async () => {
    const inbound = randomUUID();
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .set("X-Request-Id", inbound)
      .send({ email: user.email, password: "wrong-password-12" })
      .expect(401);

    const rows = await sql<
      { request_id: string | null; reason: string | null }[]
    >`
      SELECT request_id, metadata->>'reason' AS reason
        FROM audit_log
       WHERE action = 'user.login' AND outcome = 'failure'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.reason).toBe("wrong_password");
    // The audit row was written via runPrivileged (durable: true) inside
    // a transaction that survives the controller's 401 throw. The
    // request_id must be carried into that transaction via the ALS
    // service — this assertion is the canonical regression.
    expect(rows[0]?.request_id).toBe(inbound);
  });

  // ---------- audit-log integration: rate-limit denial ----------

  it("rate-limit denial audit row carries the request_id of the denied request", async () => {
    // Burn through the per-email limit (test env: 3 / 10 s).
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: user.email, password: `wrong-pwd-${i}-x` })
        .expect(401);
    }

    const denyingId = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .set("X-Request-Id", denyingId)
      .send({ email: user.email, password: "wrong-pwd-final-x" })
      .expect(429);

    expect(res.headers["x-request-id"]).toBe(denyingId);
    expect(res.body.request_id).toBe(denyingId);

    const rows = await sql<
      { request_id: string | null; reason: string | null }[]
    >`
      SELECT request_id, metadata->>'reason' AS reason
        FROM audit_log
       WHERE action = 'user.login' AND outcome = 'denied'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.reason).toBe("rate_limit_exceeded");
    expect(rows[0]?.request_id).toBe(denyingId);
  });
});
