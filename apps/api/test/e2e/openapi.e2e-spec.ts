import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { OpenApiService } from "../../src/modules/openapi/openapi.service";
import { buildOpenApiDocument } from "../../src/modules/openapi/build-openapi-document";

/**
 * OpenAPI document + gated /v1/openapi.json (P1.10 / ADR-0028).
 *
 * The test app doesn't run main.ts, so we build the document here (exactly as
 * main.ts does) and stash it in OpenApiService. NOTE: the @nestjs/swagger CLI
 * plugin runs during `nest build`, not under ts-jest — so request-BODY schemas
 * are thinner here than in a real build. These tests therefore assert the
 * plugin-INDEPENDENT contract: the gate, the path set, operational exclusion,
 * and the bearer security scheme. Rich request/response schemas are verified in
 * the live smoke (built via `nest build`).
 */
describe("OpenAPI document", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    app = await buildTestApp();
    // Mirror main.ts: generate the document once and register it.
    app.get(OpenApiService).setDocument(buildOpenApiDocument(app));
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
      tenantSlug: "openapi-tenant",
      email: "admin@openapi.test",
      password: "openapi_pw_12345",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    // A plain operator — authenticated but WITHOUT `tenant:manage`.
    member = await createUser(sql, tenant, {
      email: "member@openapi.test",
      password: "openapi_pw_12345",
    });
    await grantSystemRole(sql, member, "operator");
  });

  // ---------- gating ----------

  it("rejects anonymous access with 401", async () => {
    await request(app.getHttpServer()).get("/v1/openapi.json").expect(401);
  });

  it("rejects an authenticated non-admin with 403", async () => {
    const { accessToken } = await loginAs(app, member);
    await authed(app, accessToken).get("/v1/openapi.json").expect(403);
  });

  it("serves the document to a tenant:manage admin with 200", async () => {
    const { accessToken } = await loginAs(app, admin);
    await authed(app, accessToken).get("/v1/openapi.json").expect(200);
  });

  // ---------- document shape ----------

  it("is a valid OpenAPI 3.x document with the platform info block", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    expect(typeof res.body.openapi).toBe("string");
    expect(res.body.openapi.startsWith("3.")).toBe(true);
    expect(res.body.info.title).toBe("CMC Platform API");
    expect(res.body.info.version).toBe("1.0");
    expect(res.body.paths).toBeDefined();
  });

  it("documents the versioned domain surface under /v1", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    const paths = res.body.paths as Record<string, unknown>;
    // A representative spread across modules — all prefixed with /v1.
    expect(paths["/v1/auth/login"]).toBeDefined();
    expect(paths["/v1/incidents"]).toBeDefined();
    expect(paths["/v1/rbac/me"]).toBeDefined();
    expect(paths["/v1/notifications"]).toBeDefined();
    expect(paths["/v1/tenant"]).toBeDefined();
    // POST /v1/auth/login carries an operation object.
    expect((paths["/v1/auth/login"] as Record<string, unknown>).post).toBeDefined();
    // No bare (unversioned) domain paths leaked through.
    expect(paths["/auth/login"]).toBeUndefined();
  });

  it("excludes operational endpoints and the doc route itself", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    const paths = res.body.paths as Record<string, unknown>;
    // /health* and /metrics are operational (unversioned, ADR-0027) — not part
    // of the client contract.
    expect(paths["/health"]).toBeUndefined();
    expect(paths["/v1/health"]).toBeUndefined();
    expect(paths["/metrics"]).toBeUndefined();
    expect(paths["/v1/metrics"]).toBeUndefined();
    // The meta-endpoint excludes itself (@ApiExcludeController).
    expect(paths["/v1/openapi.json"]).toBeUndefined();
  });

  it("declares the bearer (JWT) security scheme", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    const scheme = res.body.components?.securitySchemes?.bearer;
    expect(scheme).toBeDefined();
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
    expect(scheme.bearerFormat).toBe("JWT");
  });

  // ---------- response schemas from Zod contracts (P1.10b) ----------

  it("registers the Zod contract response schemas as components", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    const schemas = (res.body.components?.schemas ?? {}) as Record<
      string,
      { type?: string }
    >;
    for (const name of [
      "LoginResponse",
      "IncidentsListResponse",
      "IncidentDetailResponse",
      "NotificationsListResponse",
      "MyAccessResponse",
      "UsersListResponse",
    ]) {
      expect(schemas[name]).toBeDefined();
      expect(schemas[name]?.type).toBe("object");
    }
  });

  it("attaches response $refs to operations from the contract map", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    const refOf = (path: string, method: string) =>
      res.body.paths?.[path]?.[method]?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema?.$ref;
    expect(refOf("/v1/incidents", "get")).toBe(
      "#/components/schemas/IncidentsListResponse",
    );
    expect(refOf("/v1/rbac/me", "get")).toBe(
      "#/components/schemas/MyAccessResponse",
    );
    expect(refOf("/v1/notifications", "get")).toBe(
      "#/components/schemas/NotificationsListResponse",
    );
  });

  it("requires bearer globally but leaves public auth endpoints open", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    // Global default → every operation needs the bearer scheme...
    expect(res.body.security).toEqual([{ bearer: [] }]);
    // ...except the explicitly public ones (login overrides to no security)...
    expect(res.body.paths["/v1/auth/login"].post.security).toEqual([]);
    // ...while an authenticated operation inherits the global requirement.
    expect(res.body.paths["/v1/incidents"].get.security).toBeUndefined();
  });

  it("groups operations under module tags", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .get("/v1/openapi.json")
      .expect(200);

    expect(res.body.paths["/v1/incidents"].get.tags).toContain("incidents");
    expect(res.body.paths["/v1/auth/mfa/status"].get.tags).toContain("mfa");
  });
});
