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
 * Admin user management (P1.4b / ADR-0022).
 *
 * Covers list/create/update/deactivate/soft-delete under `user:manage`,
 * the passwordless-invite → admin-reset login flow, deactivation revoking
 * sessions, the self-action guards, and cross-tenant isolation.
 */
describe("Admin users", () => {
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

  // ---------- list ----------

  it("admin lists the tenant's users", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-list-tenant",
      email: "admin@users.test",
      password: "users_admin_pw_1",
    });
    await createUser(sql, tenant, { email: "second@users.test" });
    const { accessToken } = await loginAs(app, admin);

    const res = await authed(app, accessToken).get("/v1/users").expect(200);
    const emails = (res.body.users as { email: string }[])
      .map((u) => u.email)
      .sort();
    expect(emails).toEqual(["admin@users.test", "second@users.test"]);
  });

  // ---------- create + invite ----------

  it("creates a passwordless user and grants initial roles", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-create-tenant",
      email: "admin@create.test",
      password: "users_create_pw1",
    });
    const { accessToken } = await loginAs(app, admin);

    const res = await authed(app, accessToken)
      .post("/v1/users")
      .send({ email: "New@create.test", name: "New User", roleSlugs: ["operator"] })
      .expect(201);
    expect(res.body.user.email).toBe("new@create.test"); // normalised
    expect(res.body.user.hasPassword).toBe(false);
    expect(res.body.user.isActive).toBe(true);
    expect(
      (res.body.user.roles as { slug: string }[]).map((r) => r.slug),
    ).toEqual(["operator"]);
  });

  it("a freshly-created user cannot log in until a password is set", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-invite-tenant",
      email: "admin@invite.test",
      password: "users_invite_pw1",
    });
    const { accessToken } = await loginAs(app, admin);

    const created = await authed(app, accessToken)
      .post("/v1/users")
      .send({ email: "invitee@invite.test", name: "Invitee" })
      .expect(201);
    const newId = created.body.user.id as string;

    // Passwordless → login impossible.
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "invitee@invite.test", password: "anything_123456" })
      .expect(401);

    // Admin reset (P1.3) sets the first password, then login works.
    const reset = await authed(app, accessToken)
      .post(`/v1/auth/password/admin-reset/${newId}`)
      .expect(201);
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token: reset.body.token, newPassword: "invitee_set_pw_9" })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "invitee@invite.test", password: "invitee_set_pw_9" })
      .expect(200);
    expect(login.body.status).toBe("ok");
  });

  it("creating a user with an existing email is 409", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-dup-tenant",
      email: "admin@dup.test",
      password: "users_dup_pw_123",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .post("/v1/users")
      .send({ email: "admin@dup.test", name: "Dup" })
      .expect(409);
  });

  it("an unknown role slug is 400 and creates nothing", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-badrole-tenant",
      email: "admin@badrole.test",
      password: "users_badrole_p1",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .post("/v1/users")
      .send({ email: "x@badrole.test", name: "X", roleSlugs: ["nope"] })
      .expect(400);
    const list = await authed(app, accessToken).get("/v1/users").expect(200);
    expect(
      (list.body.users as { email: string }[]).some(
        (u) => u.email === "x@badrole.test",
      ),
    ).toBe(false);
  });

  // ---------- update / deactivate ----------

  it("updates a user's name", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-rename-tenant",
      email: "admin@rename.test",
      password: "users_rename_pw1",
    });
    const target = await createUser(sql, tenant, { email: "t@rename.test" });
    const { accessToken } = await loginAs(app, admin);

    const res = await authed(app, accessToken)
      .patch(`/v1/users/${target.id}`)
      .send({ name: "Renamed Person" })
      .expect(200);
    expect(res.body.user.name).toBe("Renamed Person");
  });

  it("deactivating a user revokes their sessions and blocks login", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-deact-tenant",
      email: "admin@deact.test",
      password: "users_deact_pw_1",
    });
    const target = await createUser(sql, tenant, {
      email: "t@deact.test",
      password: "target_deact_pw1",
    });
    const adminTok = (await loginAs(app, admin)).accessToken;
    const targetSession = await loginAs(app, target);
    await authed(app, targetSession.accessToken).get("/v1/auth/me").expect(200);

    await authed(app, adminTok)
      .patch(`/v1/users/${target.id}`)
      .send({ isActive: false })
      .expect(200);

    // Existing session is revoked...
    await authed(app, targetSession.accessToken).get("/v1/auth/me").expect(401);
    // ...and a fresh login is refused (inactive account).
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: target.password })
      .expect(401);
  });

  // ---------- soft-delete + self guards ----------

  it("soft-deletes a user (gone from list + 404 on detail)", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-del-tenant",
      email: "admin@del.test",
      password: "users_del_pw_123",
    });
    const target = await createUser(sql, tenant, { email: "t@del.test" });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken).delete(`/v1/users/${target.id}`).expect(204);
    await authed(app, accessToken).get(`/v1/users/${target.id}`).expect(404);
    const list = await authed(app, accessToken).get("/v1/users").expect(200);
    expect(
      (list.body.users as { id: string }[]).some((u) => u.id === target.id),
    ).toBe(false);
  });

  it("an admin cannot delete or deactivate their own account", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-self-tenant",
      email: "admin@self.test",
      password: "users_self_pw_12",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken).delete(`/v1/users/${admin.id}`).expect(403);
    await authed(app, accessToken)
      .patch(`/v1/users/${admin.id}`)
      .send({ isActive: false })
      .expect(403);
  });

  // ---------- permission gate ----------

  it("a non-admin (operator) cannot use the users endpoints", async () => {
    const tenant = await createTenant(sql, { slug: "users-op-tenant" });
    const op = await createUser(sql, tenant, {
      email: "op@users.test",
      password: "users_op_pw_123",
    });
    await grantSystemRole(sql, op, "operator");
    const { accessToken } = await loginAs(app, op);

    await authed(app, accessToken).get("/v1/users").expect(403);
    await authed(app, accessToken)
      .post("/v1/users")
      .send({ email: "y@users.test", name: "Y" })
      .expect(403);
  });

  // ---------- cross-tenant isolation ----------

  it("cannot read or modify a user in another tenant (404)", async () => {
    const { user: adminA } = await createTenantWithAdmin(sql, {
      tenantSlug: "users-tenant-a",
      email: "admin@a-users.test",
      password: "users_a_pw_1234",
    });
    const tenantB = await createTenant(sql, { slug: "users-tenant-b" });
    const strangerB = await createUser(sql, tenantB, {
      email: "stranger@b-users.test",
    });
    const tokA = (await loginAs(app, adminA)).accessToken;

    await authed(app, tokA).get(`/v1/users/${strangerB.id}`).expect(404);
    await authed(app, tokA)
      .patch(`/v1/users/${strangerB.id}`)
      .send({ name: "hax" })
      .expect(404);
    await authed(app, tokA).delete(`/v1/users/${strangerB.id}`).expect(404);
  });
});
