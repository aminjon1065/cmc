import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { authed, loginAs, refresh } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Session-active cache lifecycle (P0.4 / ADR-0011).
 *
 * The cache key is `cmc:auth:session-active:<sid>`. Every successful
 * authenticated request populates it; every revoke / rotate path
 * deletes it. These tests are the canonical regression for the
 * invariant.
 *
 * `sid` is the access JWT's session id — we decode it from the base64
 * payload (no signature check needed for a test assertion).
 */
function sidFromAccessToken(token: string): string {
  const payload = token.split(".")[1]!;
  const json = Buffer.from(payload, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { sid: string };
  return parsed.sid;
}

function cacheKey(sid: string): string {
  return `cmc:auth:session-active:${sid}`;
}

describe("Session-active cache", () => {
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
      tenantSlug: "session-cache-test",
      email: "alice@cache.test",
      password: "cache_pwd_strong_12",
    });
    user = fixture.user;
  });

  // ---------- population ----------

  it("populates the cache after the first authenticated request", async () => {
    const login = await loginAs(app, user);
    const sid = sidFromAccessToken(login.accessToken);

    // Login itself does not populate the cache (the middleware fires on
    // the *next* request that carries the token).
    await expect(redis.exists(cacheKey(sid))).resolves.toBe(0);

    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);

    // After /auth/me the cache key exists with the expected payload.
    const raw = await redis.get(cacheKey(sid));
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as { userId: string; tenantId: string };
    expect(payload.userId).toBe(user.id);
    expect(payload.tenantId).toBe(user.tenantId);

    // TTL is set (positive).
    const ttl = await redis.ttl(cacheKey(sid));
    expect(ttl).toBeGreaterThan(0);
  });

  it("subsequent requests with the same token keep the cache populated", async () => {
    const login = await loginAs(app, user);
    const sid = sidFromAccessToken(login.accessToken);

    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);
    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);
    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);

    // Still cached after multiple authed reads.
    await expect(redis.exists(cacheKey(sid))).resolves.toBe(1);
  });

  // ---------- logout ----------

  it("logout DELs the cache entry", async () => {
    const login = await loginAs(app, user);
    const sid = sidFromAccessToken(login.accessToken);

    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);
    await expect(redis.exists(cacheKey(sid))).resolves.toBe(1);

    await authed(app, login.accessToken).post("/v1/auth/logout").expect(204);

    // Cache key gone — next request for this sid would miss and fall
    // through to DB (which now shows revoked_at set).
    await expect(redis.exists(cacheKey(sid))).resolves.toBe(0);

    // And the token is dead.
    await authed(app, login.accessToken).get("/v1/auth/me").expect(401);
  });

  // ---------- admin revoke (DELETE /auth/sessions/:id) ----------

  it("admin revoke of another session DELs that session's cache entry", async () => {
    const a = await loginAs(app, user);
    const b = await loginAs(app, user);
    const aSid = sidFromAccessToken(a.accessToken);
    const bSid = sidFromAccessToken(b.accessToken);

    // Warm both cache entries via authed requests.
    await authed(app, a.accessToken).get("/v1/auth/me").expect(200);
    await authed(app, b.accessToken).get("/v1/auth/me").expect(200);

    await expect(redis.exists(cacheKey(aSid))).resolves.toBe(1);
    await expect(redis.exists(cacheKey(bSid))).resolves.toBe(1);

    // From session A, revoke session B.
    await authed(app, a.accessToken)
      .delete(`/v1/auth/sessions/${bSid}`)
      .expect(204);

    // B's cache entry gone; A's still present.
    await expect(redis.exists(cacheKey(bSid))).resolves.toBe(0);
    await expect(redis.exists(cacheKey(aSid))).resolves.toBe(1);

    // B's token is dead.
    await authed(app, b.accessToken).get("/v1/auth/me").expect(401);
    // A's token still works.
    await authed(app, a.accessToken).get("/v1/auth/me").expect(200);
  });

  // ---------- refresh-rotation ----------

  it("rotate DELs the predecessor's cache entry; successor is uncached until first use", async () => {
    const login = await loginAs(app, user);
    const oldSid = sidFromAccessToken(login.accessToken);

    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);
    await expect(redis.exists(cacheKey(oldSid))).resolves.toBe(1);

    const rotated = await refresh(app, login.refreshToken);
    const newSid = sidFromAccessToken(rotated.accessToken);
    expect(newSid).not.toBe(oldSid);

    // Predecessor cache entry gone immediately.
    await expect(redis.exists(cacheKey(oldSid))).resolves.toBe(0);
    // Successor not pre-warmed — lazy populate on first authed request.
    await expect(redis.exists(cacheKey(newSid))).resolves.toBe(0);

    await authed(app, rotated.accessToken).get("/v1/auth/me").expect(200);
    await expect(redis.exists(cacheKey(newSid))).resolves.toBe(1);
  });

  // ---------- refresh-replay family burn ----------

  it("refresh-replay burns every cache entry in the family", async () => {
    const login = await loginAs(app, user);
    const sidA = sidFromAccessToken(login.accessToken);

    const rotated = await refresh(app, login.refreshToken);
    const sidB = sidFromAccessToken(rotated.accessToken);

    // Warm sidB's cache entry. sidA's cache was already invalidated by
    // the legitimate rotate (asserted above).
    await authed(app, rotated.accessToken).get("/v1/auth/me").expect(200);
    await expect(redis.exists(cacheKey(sidB))).resolves.toBe(1);

    // Replay the original (already-rotated) refresh token → family
    // burn → both sidA and sidB are revoked AND their cache entries
    // DEL'd.
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: login.refreshToken })
      .expect(401);

    await expect(redis.exists(cacheKey(sidA))).resolves.toBe(0);
    await expect(redis.exists(cacheKey(sidB))).resolves.toBe(0);

    // sidB's access token now fails — middleware finds revoked row.
    await authed(app, rotated.accessToken).get("/v1/auth/me").expect(401);
  });

  // ---------- payload mismatch defence-in-depth ----------

  it("a poisoned cache entry with wrong userId is ignored; the request falls through to DB", async () => {
    const login = await loginAs(app, user);
    const sid = sidFromAccessToken(login.accessToken);

    // Poison the cache: claim the sid is "active" but for a different
    // user. The middleware must NOT trust this payload — it has to
    // verify userId/tenantId match the JWT claims, and on mismatch
    // fall through to the DB.
    await redis.set(
      cacheKey(sid),
      JSON.stringify({
        userId: "00000000-0000-0000-0000-000000000000",
        tenantId: "11111111-1111-1111-1111-111111111111",
      }),
      "EX",
      60,
    );

    // Request still succeeds — DB confirms the session is real and
    // belongs to the right user.
    await authed(app, login.accessToken).get("/v1/auth/me").expect(200);

    // And the poisoned entry gets overwritten with the correct payload
    // (the middleware repopulates after the DB confirms active).
    const raw = await redis.get(cacheKey(sid));
    expect(raw).not.toBeNull();
    const payload = JSON.parse(raw!) as { userId: string; tenantId: string };
    expect(payload.userId).toBe(user.id);
    expect(payload.tenantId).toBe(user.tenantId);
  });
});
