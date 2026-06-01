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
  ensureSystemRole,
  assignRole,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * RBAC (P1.1 / ADR-0019).
 *
 * Covers permission resolution per system role, the @Authorize guard's 403,
 * the assign/remove flow (with cache invalidation), and cross-tenant role
 * isolation. The documents protection is exercised here too — a role without
 * `document:write` cannot upload.
 */
describe("RBAC", () => {
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

  // ---------- documents protection by role ----------

  it("tenant_admin can list AND upload documents", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "admin-tenant",
      email: "admin@rbac.test",
      password: "rbac_admin_pwd_12",
    });
    const { accessToken } = await loginAs(app, user);

    await authed(app, accessToken).get("/v1/documents").expect(200);
    await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({ name: "f.pdf", mimeType: "application/pdf", sizeBytes: 10 })
      .expect(201);
  });

  it("operator can read + write but NOT delete documents", async () => {
    const tenant = await createTenant(sql, { slug: "op-tenant" });
    const user = await createUser(sql, tenant, {
      email: "op@rbac.test",
      password: "rbac_op_pwd_123",
    });
    await grantSystemRole(sql, user, "operator");
    const { accessToken } = await loginAs(app, user);

    await authed(app, accessToken).get("/v1/documents").expect(200);
    const init = await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({ name: "f.pdf", mimeType: "application/pdf", sizeBytes: 10 })
      .expect(201);
    // operator lacks document:delete → 403
    await authed(app, accessToken)
      .delete(`/v1/documents/${init.body.document.id}`)
      .expect(403);
  });

  it("auditor can read but NOT write documents", async () => {
    const tenant = await createTenant(sql, { slug: "aud-tenant" });
    const user = await createUser(sql, tenant, {
      email: "aud@rbac.test",
      password: "rbac_aud_pwd_12",
    });
    await grantSystemRole(sql, user, "auditor");
    const { accessToken } = await loginAs(app, user);

    await authed(app, accessToken).get("/v1/documents").expect(200);
    await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({ name: "f.pdf", mimeType: "application/pdf", sizeBytes: 10 })
      .expect(403);
  });

  it("a user with NO role is denied every protected document route", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "norole-tenant",
      email: "norole@rbac.test",
      password: "rbac_norole_pwd1",
      grantAdminRole: false,
    });
    const { accessToken } = await loginAs(app, user);

    await authed(app, accessToken).get("/v1/documents").expect(403);
    await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({ name: "f.pdf", mimeType: "application/pdf", sizeBytes: 10 })
      .expect(403);
  });

  // ---------- denied audit ----------

  it("a denied request writes a durable rbac.access.denied audit row", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "denied-tenant",
      email: "denied@rbac.test",
      password: "rbac_denied_pwd1",
      grantAdminRole: false,
    });
    const { accessToken } = await loginAs(app, user);

    await authed(app, accessToken).get("/v1/documents").expect(403);

    const rows = await sql<{ action: string; resource_id: string | null }[]>`
      SELECT action, resource_id FROM audit_log
       WHERE action = 'rbac.access.denied'
       ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(rows[0]?.action).toBe("rbac.access.denied");
    expect(rows[0]?.resource_id).toBe("document:read");
  });

  // ---------- roles admin endpoints ----------

  it("GET /rbac/roles lists the tenant's system roles with permissions", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "roles-tenant",
      email: "admin@roles.test",
      password: "rbac_roles_pwd_1",
    });
    const { accessToken } = await loginAs(app, user);

    const res = await authed(app, accessToken).get("/v1/rbac/roles").expect(200);
    const slugs = (res.body.roles as { slug: string }[])
      .map((r) => r.slug)
      .sort();
    expect(slugs).toEqual(["auditor", "operator", "tenant_admin"]);
    const admin = res.body.roles.find(
      (r: { slug: string }) => r.slug === "tenant_admin",
    );
    expect(admin.permissions).toContain("document:delete");
    expect(admin.isSystem).toBe(true);
  });

  it("assigning a role grants access immediately (cache invalidated)", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "assign-tenant",
      email: "admin@assign.test",
      password: "rbac_assign_pwd1",
    });
    // A second user with no role.
    const target = await createUser(sql, tenant, {
      email: "target@assign.test",
      password: "rbac_target_pwd1",
    });

    const adminTok = (await loginAs(app, admin)).accessToken;
    const targetTok = (await loginAs(app, target)).accessToken;

    // Target starts with no access.
    await authed(app, targetTok).get("/v1/documents").expect(403);

    // Resolve the operator role id, assign via the API.
    const rolesRes = await authed(app, adminTok).get("/v1/rbac/roles").expect(200);
    const operatorRole = rolesRes.body.roles.find(
      (r: { slug: string }) => r.slug === "operator",
    );
    await authed(app, adminTok)
      .post(`/v1/rbac/users/${target.id}/roles`)
      .send({ roleId: operatorRole.id })
      .expect(204);

    // Now the target can read (the assign path invalidated their perm cache).
    await authed(app, targetTok).get("/v1/documents").expect(200);

    // Remove it again → access revoked.
    await authed(app, adminTok)
      .delete(`/v1/rbac/users/${target.id}/roles/${operatorRole.id}`)
      .expect(204);
    await authed(app, targetTok).get("/v1/documents").expect(403);
  });

  it("operator cannot use the role-admin endpoints (needs role:assign)", async () => {
    const tenant = await createTenant(sql, { slug: "noadmin-tenant" });
    const user = await createUser(sql, tenant, {
      email: "op2@rbac.test",
      password: "rbac_op2_pwd_12",
    });
    await grantSystemRole(sql, user, "operator");
    const { accessToken } = await loginAs(app, user);

    // operator lacks role:read AND role:assign.
    await authed(app, accessToken).get("/v1/rbac/roles").expect(403);
    await authed(app, accessToken)
      .post(`/v1/rbac/users/${user.id}/roles`)
      .send({ roleId: "00000000-0000-4000-8000-000000000000" })
      .expect(403);
  });

  // ---------- cross-tenant isolation ----------

  it("a tenant's roles are isolated from another tenant", async () => {
    const { user: adminA } = await createTenantWithAdmin(sql, {
      tenantSlug: "tenant-a-rbac",
      email: "admin@a.test",
      password: "rbac_a_pwd_1234",
    });
    // Tenant B has its own roles.
    const tenantB = await createTenant(sql, { slug: "tenant-b-rbac" });
    await ensureSystemRole(sql, tenantB.id, "tenant_admin");

    const tokA = (await loginAs(app, adminA)).accessToken;
    const res = await authed(app, tokA).get("/v1/rbac/roles").expect(200);

    // Every role returned belongs to tenant A (its own 3 system roles), not B's.
    expect(res.body.roles).toHaveLength(3);
    // (RLS guarantees A can't even see B's role ids; the count is the proof.)
  });

  // ---------- GET /rbac/me (P1.4a / ADR-0022) ----------

  it("GET /rbac/me returns the admin's effective roles + permissions", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "me-admin-tenant",
      email: "admin@me.test",
      password: "rbac_me_admin_1",
    });
    const { accessToken } = await loginAs(app, user);

    const res = await authed(app, accessToken).get("/v1/rbac/me").expect(200);
    expect(res.body.userId).toBe(user.id);
    const slugs = (res.body.roles as { slug: string }[]).map((r) => r.slug);
    expect(slugs).toContain("tenant_admin");
    // tenant_admin holds "*" → includes the admin-only permissions.
    expect(res.body.permissions).toEqual(expect.arrayContaining([
      "user:manage",
      "role:read",
      "role:assign",
      "document:delete",
    ]));
  });

  it("GET /rbac/me for a role-less user returns empty roles + permissions", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "me-norole-tenant",
      email: "norole@me.test",
      password: "rbac_me_norole1",
      grantAdminRole: false,
    });
    const { accessToken } = await loginAs(app, user);

    const res = await authed(app, accessToken).get("/v1/rbac/me").expect(200);
    expect(res.body.roles).toEqual([]);
    expect(res.body.permissions).toEqual([]);
  });

  it("GET /rbac/me requires authentication", async () => {
    await request(app.getHttpServer()).get("/v1/rbac/me").expect(401);
  });

  it("an operator (no role:read) can still read their OWN access via /rbac/me", async () => {
    const tenant = await createTenant(sql, { slug: "me-operator-tenant" });
    const user = await createUser(sql, tenant, {
      email: "op@me.test",
      password: "rbac_me_op_pwd1",
    });
    await grantSystemRole(sql, user, "operator");
    const { accessToken } = await loginAs(app, user);

    // /rbac/roles needs role:read → 403, but /rbac/me is self-scoped → 200.
    await authed(app, accessToken).get("/v1/rbac/roles").expect(403);
    const res = await authed(app, accessToken).get("/v1/rbac/me").expect(200);
    expect((res.body.roles as { slug: string }[]).map((r) => r.slug)).toEqual([
      "operator",
    ]);
    expect(res.body.permissions).toContain("document:write");
    expect(res.body.permissions).not.toContain("user:manage");
  });

  // ---------- custom-role management (P1.4c / ADR-0022) ----------

  it("GET /rbac/permissions returns the catalog", async () => {
    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "perms-cat-tenant",
      email: "admin@permscat.test",
      password: "rbac_permscat_1",
    });
    const { accessToken } = await loginAs(app, user);

    const res = await authed(app, accessToken)
      .get("/v1/rbac/permissions")
      .expect(200);
    const keys = (res.body.permissions as { key: string }[]).map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining(["document:read", "role:manage", "user:manage"]),
    );
  });

  it("creates a custom role, assigns it, and its permissions take effect", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "customrole-tenant",
      email: "admin@customrole.test",
      password: "rbac_customrole1",
    });
    const target = await createUser(sql, tenant, {
      email: "t@customrole.test",
      password: "rbac_crt_target1",
    });
    const adminTok = (await loginAs(app, admin)).accessToken;
    const targetTok = (await loginAs(app, target)).accessToken;

    // No role → no document access.
    await authed(app, targetTok).get("/v1/documents").expect(403);

    // Create a custom "doc_reader" role with document:read.
    const created = await authed(app, adminTok)
      .post("/v1/rbac/roles")
      .send({
        slug: "doc_reader",
        name: "Doc Reader",
        permissions: ["document:read"],
      })
      .expect(201);
    expect(created.body.role.isSystem).toBe(false);
    const roleId = created.body.role.id as string;

    // Assign it → target can now read (perm cache invalidated on assign).
    await authed(app, adminTok)
      .post(`/v1/rbac/users/${target.id}/roles`)
      .send({ roleId })
      .expect(204);
    await authed(app, targetTok).get("/v1/documents").expect(200);

    // Editing the role to drop the permission revokes access (cache cleared).
    await authed(app, adminTok)
      .patch(`/v1/rbac/roles/${roleId}`)
      .send({ permissions: [] })
      .expect(200);
    await authed(app, targetTok).get("/v1/documents").expect(403);
  });

  it("deleting a custom role removes it and revokes its access", async () => {
    const { tenant, user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "delrole-tenant",
      email: "admin@delrole.test",
      password: "rbac_delrole_12",
    });
    const target = await createUser(sql, tenant, {
      email: "t@delrole.test",
      password: "rbac_delrole_t1",
    });
    const adminTok = (await loginAs(app, admin)).accessToken;
    const targetTok = (await loginAs(app, target)).accessToken;

    const created = await authed(app, adminTok)
      .post("/v1/rbac/roles")
      .send({ slug: "temp_reader", name: "Temp", permissions: ["document:read"] })
      .expect(201);
    const roleId = created.body.role.id as string;
    await authed(app, adminTok)
      .post(`/v1/rbac/users/${target.id}/roles`)
      .send({ roleId })
      .expect(204);
    await authed(app, targetTok).get("/v1/documents").expect(200);

    // Delete the role → cascade removes the assignment; access revoked.
    await authed(app, adminTok).delete(`/v1/rbac/roles/${roleId}`).expect(204);
    await authed(app, targetTok).get("/v1/documents").expect(403);
    const list = await authed(app, adminTok).get("/v1/rbac/roles").expect(200);
    expect(
      (list.body.roles as { id: string }[]).some((r) => r.id === roleId),
    ).toBe(false);
  });

  it("system roles cannot be edited or deleted", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "sysrole-tenant",
      email: "admin@sysrole.test",
      password: "rbac_sysrole_12",
    });
    const adminTok = (await loginAs(app, admin)).accessToken;
    const roles = await authed(app, adminTok).get("/v1/rbac/roles").expect(200);
    const adminRole = (roles.body.roles as { id: string; slug: string }[]).find(
      (r) => r.slug === "tenant_admin",
    )!;

    await authed(app, adminTok)
      .patch(`/v1/rbac/roles/${adminRole.id}`)
      .send({ name: "Hacked" })
      .expect(403);
    await authed(app, adminTok)
      .delete(`/v1/rbac/roles/${adminRole.id}`)
      .expect(403);
  });

  it("rejects a duplicate slug (409), unknown permission (400), bad slug (400)", async () => {
    const { user: admin } = await createTenantWithAdmin(sql, {
      tenantSlug: "rolevalidation-tenant",
      email: "admin@roleval.test",
      password: "rbac_roleval_12",
    });
    const adminTok = (await loginAs(app, admin)).accessToken;

    // Slug collides with a seeded system role.
    await authed(app, adminTok)
      .post("/v1/rbac/roles")
      .send({ slug: "operator", name: "Dup", permissions: [] })
      .expect(409);
    // Unknown permission key.
    await authed(app, adminTok)
      .post("/v1/rbac/roles")
      .send({ slug: "weird", name: "Weird", permissions: ["does:notexist"] })
      .expect(400);
    // Invalid slug format (caught by the DTO).
    await authed(app, adminTok)
      .post("/v1/rbac/roles")
      .send({ slug: "Bad Slug", name: "Bad", permissions: [] })
      .expect(400);
  });

  it("role:manage is required to create roles (auditor with role:read cannot)", async () => {
    const tenant = await createTenant(sql, { slug: "rolegate-tenant" });
    const auditor = await createUser(sql, tenant, {
      email: "auditor@rolegate.test",
      password: "rbac_rolegate_1",
    });
    await grantSystemRole(sql, auditor, "auditor");
    const { accessToken } = await loginAs(app, auditor);

    // auditor HAS role:read → can view the catalog...
    await authed(app, accessToken).get("/v1/rbac/permissions").expect(200);
    // ...but NOT role:manage → cannot create.
    await authed(app, accessToken)
      .post("/v1/rbac/roles")
      .send({ slug: "nope", name: "Nope", permissions: [] })
      .expect(403);
  });

  it("cannot edit or delete a role in another tenant (404)", async () => {
    const { user: adminA } = await createTenantWithAdmin(sql, {
      tenantSlug: "role-tenant-a",
      email: "admin@role-a.test",
      password: "rbac_role_a_123",
    });
    const tenantB = await createTenant(sql, { slug: "role-tenant-b" });
    await ensureSystemRole(sql, tenantB.id, "tenant_admin");
    // A custom role in tenant B (owner-inserted).
    const roleBRows = await sql<{ id: string }[]>`
      INSERT INTO roles (tenant_id, slug, name, is_system)
      VALUES (${tenantB.id}, 'b_custom', 'B Custom', false)
      RETURNING id`;
    const roleBId = roleBRows[0]!.id;
    const tokA = (await loginAs(app, adminA)).accessToken;

    await authed(app, tokA)
      .patch(`/v1/rbac/roles/${roleBId}`)
      .send({ name: "x" })
      .expect(404);
    await authed(app, tokA).delete(`/v1/rbac/roles/${roleBId}`).expect(404);
  });
});
