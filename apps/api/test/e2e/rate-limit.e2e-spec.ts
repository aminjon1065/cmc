import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Rate-limit tests (P0.1 / ADR-0009).
 *
 * Test env limits (apps/api/.env.test.example):
 *   AUTH_LOGIN_IP_LIMIT=5
 *   AUTH_LOGIN_EMAIL_LIMIT=3
 *   AUTH_REFRESH_IP_LIMIT=5
 *
 * Each test wipes both Postgres rows AND the `cmc:auth:rate-limit:*`
 * Redis namespace so counter state doesn't leak across cases. The IP
 * counter would otherwise accumulate (supertest always connects from
 * loopback) and break later cases.
 */
describe("Auth rate limiting", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let user: TestUser;

  // X-Forwarded-For values used to differentiate test "clients". The
  // app trusts forwarded headers from loopback (see main.ts), so these
  // become the effective req.ip for rate-limit keying.
  const IP_A = "203.0.113.10";
  const IP_B = "203.0.113.20";

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
    // truncateAll(sql, redis) wipes both Postgres rows and the rate-limit
    // keys (see test-db.ts) — keeps cases isolated despite shared loopback IP.
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "rate-limit-test",
      email: "alice@rate.test",
      password: "rate_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- under-limit sanity ----------

  it("returns 401 (not 429) for the first few wrong-password attempts", async () => {
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        .send({ email: user.email, password: "definitely_wrong" })
        .expect(401);
    }
  });

  // ---------- per-email limit fires before per-IP for one email ----------

  it("per-email limit: 3 wrong attempts on one email → 4th is 429", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        .send({ email: user.email, password: `wrong-pwd-${i}-x` })
        .expect(401);
    }

    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_A)
      .send({ email: user.email, password: "still-wrong" })
      .expect(429);

    expect(res.body).toMatchObject({
      title: "Too Many Requests",
      status: 429,
      limit_name: "auth-login-email",
    });
    expect(res.body.retry_after_sec).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  // ---------- per-IP limit isolated from per-email ----------

  it("per-IP limit: 5 wrong attempts across 5 distinct emails → 6th is 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        // Each attempt is a fresh email so the per-email limit (3) is
        // never reached — only the IP limit (5) accumulates.
        .send({ email: `ghost-${i}@rate.test`, password: "no-such-user" })
        .expect(401);
    }

    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_A)
      .send({ email: "ghost-final@rate.test", password: "no-such-user" })
      .expect(429);

    expect(res.body.limit_name).toBe("auth-login-ip");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  // ---------- isolation across IPs ----------

  it("per-IP isolation: exhausting IP_A does not block IP_B", async () => {
    // Exhaust IP_A on novel emails (so per-email is irrelevant).
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        .send({ email: `ip-a-${i}@rate.test`, password: "wrong-pwd-12" })
        // First 5 → 401; the 6th → 429. Either is fine for this assertion.
        .expect((r) => {
          if (r.status !== 401 && r.status !== 429) {
            throw new Error(`unexpected status ${r.status}`);
          }
        });
    }

    // From a different IP the counter is fresh — wrong password → 401.
    await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_B)
      .send({ email: "ip-b-clean@rate.test", password: "wrong-pwd-12" })
      .expect(401);
  });

  // ---------- isolation across emails ----------

  it("per-email isolation: exhausting email A does not block email B", async () => {
    // Three wrong attempts on user.email → per-email limit (3) reached.
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        .send({ email: user.email, password: "wrong-pwd-12" })
        .expect(401);
    }
    // Fourth attempt on the SAME email from the SAME IP → 429 on the
    // per-email key.
    await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_A)
      .send({ email: user.email, password: "wrong-pwd-12" })
      .expect(429);

    // A DIFFERENT email from the same IP — still under the per-IP limit
    // (we've consumed 4/5 IP counts, but per-email is fresh). Expect 401
    // (unknown email), not 429.
    await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_A)
      .send({ email: "untouched@rate.test", password: "wrong-pwd-12" })
      .expect(401);
  });

  // ---------- audit on breach ----------

  it("writes a denied audit row on rate-limit breach", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post("/auth/login")
        .set("X-Forwarded-For", IP_A)
        .send({ email: user.email, password: "wrong-pwd-12" })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post("/auth/login")
      .set("X-Forwarded-For", IP_A)
      .send({ email: user.email, password: "wrong-pwd-12" })
      .expect(429);

    const rows = await sql<
      {
        action: string;
        outcome: string;
        reason: string | null;
        limit_name: string | null;
        ip: string | null;
      }[]
    >`
      SELECT action, outcome,
             metadata->>'reason'      AS reason,
             metadata->>'limit_name'  AS limit_name,
             host(ip)                 AS ip
        FROM audit_log
       WHERE action = 'user.login'
         AND outcome = 'denied'
       ORDER BY occurred_at DESC
       LIMIT 1
    `;
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.reason).toBe("rate_limit_exceeded");
    expect(rows[0]!.limit_name).toBe("auth-login-email");
    expect(rows[0]!.ip).toBe(IP_A);
  });

  // ---------- refresh limit ----------

  it("refresh: 5 garbage tokens → 6th is 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("X-Forwarded-For", IP_A)
        // Each token is 48+ chars to satisfy the DTO MinLength so we
        // exercise the rate-limit, not the validator.
        .send({ refreshToken: `x`.repeat(48) + i })
        .expect(401);
    }
    const res = await request(app.getHttpServer())
      .post("/auth/refresh")
      .set("X-Forwarded-For", IP_A)
      .send({ refreshToken: `x`.repeat(48) + "final" })
      .expect(429);

    expect(res.body.limit_name).toBe("auth-refresh-ip");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
