import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Self-service UI preferences (ADR-0078): `GET/PATCH /v1/me/preferences`.
 * Any authenticated user reads/updates their OWN persisted theme + locale.
 * Covers defaults, set/get round-trip, partial patch, clear-with-null,
 * enum + whitelist validation (400), auth (401), and per-user isolation.
 */
describe("UI preferences (/v1/me/preferences, ADR-0078)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const created = await createTenantWithAdmin(sql);
    tenant = created.tenant;
    adminToken = (await loginAs(app, created.user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("returns null defaults for a user with no saved preference", async () => {
    const res = await authed(app, adminToken)
      .get("/v1/me/preferences")
      .expect(200);
    expect(res.body).toEqual({ theme: null, locale: null });
  });

  it("PATCH sets theme + locale and GET reflects it", async () => {
    const patched = await authed(app, adminToken)
      .patch("/v1/me/preferences")
      .send({ theme: "dark", locale: "tg" })
      .expect(200);
    expect(patched.body).toEqual({ theme: "dark", locale: "tg" });

    const got = await authed(app, adminToken)
      .get("/v1/me/preferences")
      .expect(200);
    expect(got.body).toEqual({ theme: "dark", locale: "tg" });
  });

  it("PATCH with one field leaves the other unchanged", async () => {
    const res = await authed(app, adminToken)
      .patch("/v1/me/preferences")
      .send({ theme: "system" })
      .expect(200);
    expect(res.body).toEqual({ theme: "system", locale: "tg" });
  });

  it("PATCH with null clears a preference", async () => {
    const res = await authed(app, adminToken)
      .patch("/v1/me/preferences")
      .send({ theme: null })
      .expect(200);
    expect(res.body).toEqual({ theme: null, locale: "tg" });
  });

  it("rejects an invalid theme enum (400)", async () => {
    await authed(app, adminToken)
      .patch("/v1/me/preferences")
      .send({ theme: "blue" })
      .expect(400);
  });

  it("rejects an unknown key (whitelist, 400)", async () => {
    await authed(app, adminToken)
      .patch("/v1/me/preferences")
      .send({ fontSize: "huge" })
      .expect(400);
  });

  it("requires authentication (401)", async () => {
    const { default: request } = await import("supertest");
    await request(app.getHttpServer()).get("/v1/me/preferences").expect(401);
  });

  it("preferences are per-user (a second user keeps its own defaults)", async () => {
    const other = await createUser(sql, tenant);
    const otherToken = (await loginAs(app, other)).accessToken;
    const res = await authed(app, otherToken)
      .get("/v1/me/preferences")
      .expect(200);
    // admin set theme=null/locale=tg above; this fresh user is untouched.
    expect(res.body).toEqual({ theme: null, locale: null });
  });
});
