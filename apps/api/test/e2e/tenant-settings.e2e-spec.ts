import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenant,
  createUser,
  createTenantWithAdmin,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Tenant self-settings (P1.4d / ADR-0022).
 *
 * GET/PATCH /tenant (name) + PUT /branding (copy/logo/locale), all gated by
 * `tenant:manage`. GET /branding stays public. Branding copy updates MERGE.
 */
describe("Tenant settings", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;

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
  });

  it("GET /tenant returns the caller's tenant identity", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "settings-tenant",
      email: "admin@settings.test",
      password: "settings_pw_1234",
    });
    const { accessToken } = await loginAs(app, admin);

    const res = await authed(app, accessToken).get("/v1/tenant").expect(200);
    expect(res.body).toMatchObject({ id: tenant.id, slug: "settings-tenant" });
    expect(typeof res.body.name).toBe("string");
  });

  it("PATCH /tenant renames the tenant", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "rename-tenant",
      email: "admin@renametenant.test",
      password: "rename_pw_12345",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .patch("/v1/tenant")
      .send({ name: "Republican Crisis HQ" })
      .expect(200);
    const res = await authed(app, accessToken).get("/v1/tenant").expect(200);
    expect(res.body.name).toBe("Republican Crisis HQ");
  });

  it("PUT /branding updates copy/logo/locale and GET /branding reflects it", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "branding-tenant",
      email: "admin@branding.test",
      password: "branding_pw_1234",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .put("/v1/branding")
      .send({
        localeDefault: "ru",
        logoUrl: "https://cdn.example.tj/logo.png",
        copy: { orgName: "Crisis Center TJ" },
      })
      .expect(200);

    const res = await authed(app, accessToken).get("/v1/branding").expect(200);
    expect(res.body.localeDefault).toBe("ru");
    expect(res.body.logoUrl).toBe("https://cdn.example.tj/logo.png");
    expect(res.body.copy.orgName).toBe("Crisis Center TJ");
    // Unsupplied copy keys fall back to the generic default.
    expect(typeof res.body.copy.orgShort).toBe("string");
  });

  it("branding copy updates MERGE (a later partial preserves earlier keys)", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "merge-tenant",
      email: "admin@merge.test",
      password: "merge_pw_123456",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .put("/v1/branding")
      .send({ copy: { orgName: "First Name" } })
      .expect(200);
    await authed(app, accessToken)
      .put("/v1/branding")
      .send({ copy: { orgShort: "Second Short" } })
      .expect(200);

    const res = await authed(app, accessToken).get("/v1/branding").expect(200);
    expect(res.body.copy.orgName).toBe("First Name");
    expect(res.body.copy.orgShort).toBe("Second Short");
  });

  it("invalid input is rejected (bad logo URL, empty name)", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "validate-tenant",
      email: "admin@validatetenant.test",
      password: "validate_pw_1234",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .put("/v1/branding")
      .send({ logoUrl: "not-a-url" })
      .expect(400);
    await authed(app, accessToken)
      .patch("/v1/tenant")
      .send({ name: "" })
      .expect(400);
  });

  it("tenant:manage is required for all tenant-settings routes", async () => {
    const tenant = await createTenant(sql, { slug: "settings-gate-tenant" });
    const op = await createUser(sql, tenant, {
      email: "op@settingsgate.test",
      password: "settings_op_pw12",
    });
    await grantSystemRole(sql, op, "operator");
    const { accessToken } = await loginAs(app, op);

    await authed(app, accessToken).get("/v1/tenant").expect(403);
    await authed(app, accessToken)
      .patch("/v1/tenant")
      .send({ name: "x" })
      .expect(403);
    await authed(app, accessToken)
      .put("/v1/branding")
      .send({ copy: { orgName: "x" } })
      .expect(403);
  });

  it("GET /branding stays public (no auth required)", async () => {
    await request(app.getHttpServer()).get("/v1/branding").expect(200);
  });
});
