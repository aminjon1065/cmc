import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Regions (P4.6a / ADR-0064). Per-tenant region catalog + CRUD, default TJ
 * region seed, RBAC (`region:read`/`region:manage`), user→region assignment via
 * the admin-users surface, and tenant isolation. All against real Postgres + RLS.
 */
describe("Regions (P4.6a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let opToken: string;
  let opUserId: string;
  let viewerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;

    const op = await createUser(sql, tenant);
    opUserId = op.id;
    await grantSystemRole(sql, op, "operator"); // region:read, not region:manage
    opToken = (await loginAs(app, op)).accessToken;

    const viewer = await createUser(sql, tenant); // no roles
    viewerToken = (await loginAs(app, viewer)).accessToken;

    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("seeds the default Tajikistan regions; region:read can list, others 403", async () => {
    const res = await authed(app, adminToken).get("/v1/regions").expect(200);
    const codes = res.body.regions.map((r: { code: string }) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["DUSHANBE", "SUGHD", "KHATLON", "GBAO", "RRP"]),
    );

    // operator has region:read.
    await authed(app, opToken).get("/v1/regions").expect(200);
    // role-less viewer does not.
    await authed(app, viewerToken).get("/v1/regions").expect(403);
  });

  it("region:manage creates a region; duplicate code → 409; bad code → 400; operator → 403", async () => {
    const created = await authed(app, adminToken)
      .post("/v1/regions")
      .send({ code: "TEST_REG", name: "Test Region" })
      .expect(201);
    expect(created.body.region.code).toBe("TEST_REG");
    expect(created.body.region.name).toBe("Test Region");

    // Duplicate code in the same tenant → 409.
    await authed(app, adminToken)
      .post("/v1/regions")
      .send({ code: "TEST_REG", name: "Dup" })
      .expect(409);

    // Invalid code (lowercase + space) → 400.
    await authed(app, adminToken)
      .post("/v1/regions")
      .send({ code: "bad code", name: "x" })
      .expect(400);

    // operator lacks region:manage.
    await authed(app, opToken)
      .post("/v1/regions")
      .send({ code: "NOPE", name: "Nope" })
      .expect(403);
  });

  it("updates a region; another tenant cannot (RLS → 404)", async () => {
    const created = await authed(app, adminToken)
      .post("/v1/regions")
      .send({ code: "RENAME_ME", name: "Before" })
      .expect(201);
    const id = created.body.region.id;

    const updated = await authed(app, adminToken)
      .patch(`/v1/regions/${id}`)
      .send({ name: "After" })
      .expect(200);
    expect(updated.body.region.name).toBe("After");

    // The other tenant cannot see/modify our region.
    await authed(app, otherToken)
      .patch(`/v1/regions/${id}`)
      .send({ name: "Hijack" })
      .expect(404);
  });

  it("assigns a user to a region and clears it; unknown region → 404", async () => {
    const list = await authed(app, adminToken).get("/v1/regions").expect(200);
    const dushanbe = list.body.regions.find(
      (r: { code: string }) => r.code === "DUSHANBE",
    );
    expect(dushanbe).toBeDefined();

    const assigned = await authed(app, adminToken)
      .patch(`/v1/users/${opUserId}`)
      .send({ regionId: dushanbe.id })
      .expect(200);
    expect(assigned.body.user.regionId).toBe(dushanbe.id);

    // Clear it.
    const cleared = await authed(app, adminToken)
      .patch(`/v1/users/${opUserId}`)
      .send({ regionId: null })
      .expect(200);
    expect(cleared.body.user.regionId).toBeNull();

    // Unknown region id → 404.
    await authed(app, adminToken)
      .patch(`/v1/users/${opUserId}`)
      .send({ regionId: "00000000-0000-0000-0000-000000000000" })
      .expect(404);
  });

  it("refuses to delete a region with assigned users; deletes once empty", async () => {
    const created = await authed(app, adminToken)
      .post("/v1/regions")
      .send({ code: "DELME", name: "Delete Me" })
      .expect(201);
    const id = created.body.region.id;

    // Assign the operator → delete blocked.
    await authed(app, adminToken)
      .patch(`/v1/users/${opUserId}`)
      .send({ regionId: id })
      .expect(200);
    await authed(app, adminToken).delete(`/v1/regions/${id}`).expect(409);

    // Unassign → delete succeeds → gone from the list.
    await authed(app, adminToken)
      .patch(`/v1/users/${opUserId}`)
      .send({ regionId: null })
      .expect(200);
    await authed(app, adminToken).delete(`/v1/regions/${id}`).expect(204);

    const list = await authed(app, adminToken).get("/v1/regions").expect(200);
    expect(list.body.regions.map((r: { id: string }) => r.id)).not.toContain(
      id,
    );
  });
});
