import request from "supertest";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * OpenTelemetry tracing (P0.6 / ADR-0013).
 *
 * Tracing is started for the test process by `test/tracing-setup.ts`
 * (a jest setupFile) with no exporter — spans are created so trace_id
 * propagates, but nothing is shipped. These tests assert the seam that
 * matters operationally: every request gets a trace id, inbound W3C
 * trace context is honoured, and the trace id lands on audit rows so
 * an auditor can pivot from a row straight into Tempo.
 */
describe("OTEL tracing", () => {
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
      tenantSlug: "tracing-test",
      email: "trace@tracing.test",
      password: "tracing_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- span creation ----------

  it("stamps an X-Trace-Id (32-hex) on a normal request", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    const traceId = res.headers["x-trace-id"];
    expect(traceId).toBeDefined();
    expect(TRACE_ID_RE.test(traceId!)).toBe(true);
  });

  // ---------- W3C trace context propagation ----------

  it("adopts the trace id from an inbound W3C traceparent", async () => {
    // version-traceid-spanid-flags
    const incomingTraceId = "0af7651916cd43dd8448eb211c80319c";
    const traceparent = `00-${incomingTraceId}-b7ad6b7169203331-01`;

    const res = await request(app.getHttpServer())
      .get("/health")
      .set("traceparent", traceparent)
      .expect(200);

    expect(res.headers["x-trace-id"]).toBe(incomingTraceId);
  });

  // ---------- audit-log integration (the headline deliverable) ----------

  it("login success populates audit_log.trace_id matching the response trace id", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);

    const traceId = res.headers["x-trace-id"];
    expect(traceId).toBeDefined();
    expect(TRACE_ID_RE.test(traceId!)).toBe(true);

    const rows = await sql<{ trace_id: string | null }[]>`
      SELECT trace_id FROM audit_log
       WHERE action = 'user.login' AND outcome = 'success'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.trace_id).toBe(traceId);
  });

  it("durable failure audit (login rollback) still carries trace_id", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: "wrong-password-12" })
      .expect(401);

    const traceId = res.headers["x-trace-id"];
    expect(traceId).toBeDefined();

    const rows = await sql<{ trace_id: string | null; reason: string | null }[]>`
      SELECT trace_id, metadata->>'reason' AS reason
        FROM audit_log
       WHERE action = 'user.login' AND outcome = 'failure'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.reason).toBe("wrong_password");
    // The durable audit runs in a fresh privileged tx that survives the
    // 401 throw; trace_id must thread into it via the ALS just like
    // request_id does.
    expect(rows[0]?.trace_id).toBe(traceId);
  });

  // ---------- co-existence with request_id ----------

  it("emits both X-Request-Id and X-Trace-Id, and they are distinct ids", async () => {
    const reqId = randomUUID();
    const res = await request(app.getHttpServer())
      .get("/health")
      .set("X-Request-Id", reqId)
      .expect(200);

    expect(res.headers["x-request-id"]).toBe(reqId);
    expect(TRACE_ID_RE.test(res.headers["x-trace-id"]!)).toBe(true);
    // request_id is a UUID (has hyphens); trace_id is 32 hex (no hyphens).
    expect(res.headers["x-trace-id"]).not.toBe(res.headers["x-request-id"]);
  });
});
