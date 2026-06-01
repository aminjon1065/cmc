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
  seedPermissions,
  assignRole,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

const OCCURRED = "2026-05-01T08:00:00.000Z";

/** Insert a custom role with explicit permission keys; return its id. */
async function createRoleWithPerms(
  sql: ReturnType<typeof ownerSql>,
  tenantId: string,
  slug: string,
  permKeys: string[],
): Promise<string> {
  await seedPermissions(sql);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO roles (tenant_id, slug, name, is_system)
    VALUES (${tenantId}, ${slug}, ${slug}, false) RETURNING id`;
  const roleId = rows[0]!.id;
  for (const key of permKeys) {
    const [domain, action] = key.split(":");
    await sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${roleId}, p.id FROM permissions p
       WHERE p.domain = ${domain!} AND p.action = ${action!}
      ON CONFLICT DO NOTHING`;
  }
  return roleId;
}

describe("Incidents", () => {
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

  async function adminToken(slug = "inc-tenant", email = "admin@inc.test") {
    const { tenant, user } = await createTenantWithAdmin(sql, {
      tenantSlug: slug,
      email,
      password: "inc_admin_pw_123",
    });
    const { accessToken } = await loginAs(app, user);
    return { tenant, admin: user, token: accessToken };
  }

  function createIncident(
    token: string,
    over: Record<string, unknown> = {},
  ) {
    return authed(app, token)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "Flood",
        region: "Khatlon",
        summary: "Vakhsh river breach",
        occurredAt: OCCURRED,
        ...over,
      });
  }

  // ---------- create + read ----------

  it("creates an incident (defaults to reported, stamps reporter)", async () => {
    const { admin, token } = await adminToken();
    const res = await createIncident(token).expect(201);
    expect(res.body.incident.status).toBe("reported");
    expect(res.body.incident.severity).toBe(2);
    expect(res.body.incident.reportedBy).toMatchObject({ id: admin.id });
    expect(res.body.incident.assignedTo).toBeNull();
    expect(res.body.incident.resolvedAt).toBeNull();
  });

  it("lists incidents with filters + pagination", async () => {
    const { token } = await adminToken();
    await createIncident(token, { region: "Khatlon", severity: 1 });
    await createIncident(token, { region: "Sughd", severity: 3 });
    await createIncident(token, { region: "Khatlon", severity: 2 });

    const all = await authed(app, token).get("/v1/incidents").expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.incidents).toHaveLength(3);

    const khatlon = await authed(app, token)
      .get("/v1/incidents?region=Khatlon")
      .expect(200);
    expect(khatlon.body.total).toBe(2);

    const sev1 = await authed(app, token)
      .get("/v1/incidents?severity=1")
      .expect(200);
    expect(sev1.body.total).toBe(1);

    const page = await authed(app, token)
      .get("/v1/incidents?limit=2&offset=0")
      .expect(200);
    expect(page.body.incidents).toHaveLength(2);
    expect(page.body.limit).toBe(2);
  });

  it("detail returns 404 for an unknown id", async () => {
    const { token } = await adminToken();
    await authed(app, token)
      .get("/v1/incidents/00000000-0000-4000-8000-000000000000")
      .expect(404);
  });

  it("updates incident fields", async () => {
    const { token } = await adminToken();
    const created = await createIncident(token).expect(201);
    const res = await authed(app, token)
      .patch(`/v1/incidents/${created.body.incident.id}`)
      .send({ severity: 1, summary: "Escalated breach" })
      .expect(200);
    expect(res.body.incident.severity).toBe(1);
    expect(res.body.incident.summary).toBe("Escalated breach");
  });

  // ---------- transitions ----------

  it("walks the status lifecycle and rejects illegal jumps", async () => {
    const { token } = await adminToken();
    const id = (await createIncident(token).expect(201)).body.incident.id;
    const to = (s: string) =>
      authed(app, token).post(`/v1/incidents/${id}/transition`).send({ to: s });

    // reported → resolved is not a legal edge.
    await to("resolved").expect(400);

    await to("triaged").expect(200);
    await to("in_progress").expect(200);
    const resolved = await to("resolved").expect(200);
    expect(resolved.body.incident.status).toBe("resolved");
    expect(resolved.body.incident.resolvedAt).not.toBeNull();

    await to("closed").expect(200);
    // closed → reported is illegal.
    await to("reported").expect(400);

    // reopen closed → in_progress clears resolvedAt.
    const reopened = await to("in_progress").expect(200);
    expect(reopened.body.incident.resolvedAt).toBeNull();
  });

  it("resolving requires incident:resolve (write alone is not enough)", async () => {
    const { tenant, token } = await adminToken();
    // A responder with read+create+write but NOT resolve.
    const responder = await createUser(sql, tenant, {
      email: "responder@inc.test",
      password: "inc_responder_p1",
    });
    const roleId = await createRoleWithPerms(sql, tenant.id, "responder", [
      "incident:read",
      "incident:create",
      "incident:write",
    ]);
    await assignRole(sql, { userId: responder.id, roleId, tenantId: tenant.id });
    const rTok = (await loginAs(app, responder)).accessToken;

    const id = (await createIncident(rTok).expect(201)).body.incident.id;
    await authed(app, rTok)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(200);
    await authed(app, rTok)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "in_progress" })
      .expect(200);
    // No incident:resolve → 403.
    await authed(app, rTok)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "resolved" })
      .expect(403);
  });

  // ---------- assign ----------

  it("assigns + unassigns an incident; rejects a cross-tenant assignee", async () => {
    const { tenant, token } = await adminToken();
    const member = await createUser(sql, tenant, {
      email: "member@inc.test",
    });
    const id = (await createIncident(token).expect(201)).body.incident.id;

    const assigned = await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);
    expect(assigned.body.incident.assignedTo).toMatchObject({ id: member.id });

    // Unassign.
    const cleared = await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: null })
      .expect(200);
    expect(cleared.body.incident.assignedTo).toBeNull();

    // A user from another tenant cannot be an assignee.
    const otherTenant = await createTenant(sql, { slug: "inc-other" });
    const stranger = await createUser(sql, otherTenant, {
      email: "stranger@inc.test",
    });
    await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: stranger.id })
      .expect(400);
  });

  // ---------- permission gates ----------

  it("an auditor can read but not create incidents", async () => {
    const tenant = await createTenant(sql, { slug: "inc-auditor" });
    const auditor = await createUser(sql, tenant, {
      email: "auditor@inc.test",
      password: "inc_auditor_pw1",
    });
    await grantSystemRole(sql, auditor, "auditor");
    const tok = (await loginAs(app, auditor)).accessToken;

    await authed(app, tok).get("/v1/incidents").expect(200);
    await createIncident(tok).expect(403);
  });

  it("an operator cannot delete incidents (admin-only)", async () => {
    const { tenant, token: adminTok } = await adminToken(
      "inc-del",
      "admin@incdel.test",
    );
    const operator = await createUser(sql, tenant, {
      email: "op@incdel.test",
      password: "inc_op_pw_12345",
    });
    await grantSystemRole(sql, operator, "operator");
    const opTok = (await loginAs(app, operator)).accessToken;

    const id = (await createIncident(opTok).expect(201)).body.incident.id;
    await authed(app, opTok).delete(`/v1/incidents/${id}`).expect(403);

    // Admin can; then it's gone.
    await authed(app, adminTok).delete(`/v1/incidents/${id}`).expect(204);
    await authed(app, adminTok).get(`/v1/incidents/${id}`).expect(404);
  });

  // ---------- cross-tenant isolation ----------

  it("cannot read or modify another tenant's incident (404)", async () => {
    const a = await adminToken("inc-a", "admin@inca.test");
    const b = await adminToken("inc-b", "admin@incb.test");
    const id = (await createIncident(a.token).expect(201)).body.incident.id;

    await authed(app, b.token).get(`/v1/incidents/${id}`).expect(404);
    await authed(app, b.token)
      .patch(`/v1/incidents/${id}`)
      .send({ severity: 5 })
      .expect(404);
    await authed(app, b.token)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(404);
    await authed(app, b.token).delete(`/v1/incidents/${id}`).expect(404);
  });

  // ---------- stats ----------

  it("stats aggregates active incidents by severity/region/type", async () => {
    const { token } = await adminToken();
    await createIncident(token, { severity: 1, region: "Khatlon", type: "Flood" });
    await createIncident(token, { severity: 2, region: "Khatlon", type: "Mudflow" });
    const closedId = (
      await createIncident(token, { severity: 3, region: "Sughd" }).expect(201)
    ).body.incident.id;
    // Resolve+close one so it drops out of "active".
    const t = (s: string) =>
      authed(app, token).post(`/v1/incidents/${closedId}/transition`).send({ to: s });
    await t("triaged");
    await t("in_progress");
    await t("resolved");
    await t("closed");

    const res = await authed(app, token).get("/v1/incidents/stats").expect(200);
    expect(res.body.activeTotal).toBe(2);
    expect(res.body.bySeverity["1"]).toBe(1);
    expect(res.body.bySeverity["2"]).toBe(1);
    const khatlon = (res.body.byRegion as { region: string; count: number }[]).find(
      (r) => r.region === "Khatlon",
    );
    expect(khatlon?.count).toBe(2);
  });

  // ---------- active filter (P1.5c) ----------

  it("the active filter excludes resolved/closed/cancelled", async () => {
    const { token } = await adminToken("inc-active", "admin@incactive.test");
    // One stays reported (active); one is driven to resolved.
    await createIncident(token, { summary: "Still active" }).expect(201);
    const resolvedId = (
      await createIncident(token, { summary: "Done" }).expect(201)
    ).body.incident.id;
    const t = (s: string) =>
      authed(app, token)
        .post(`/v1/incidents/${resolvedId}/transition`)
        .send({ to: s });
    await t("triaged");
    await t("in_progress");
    await t("resolved");

    const all = await authed(app, token).get("/v1/incidents").expect(200);
    expect(all.body.total).toBe(2);
    const active = await authed(app, token)
      .get("/v1/incidents?active=true")
      .expect(200);
    expect(active.body.total).toBe(1);
    expect(active.body.incidents[0].summary).toBe("Still active");
  });

  // ---------- assignees (P1.5b) ----------

  it("lists assignable members (incident:assign); auditor is denied", async () => {
    const { tenant, admin, token } = await adminToken(
      "inc-assignees",
      "admin@incassignees.test",
    );
    await createUser(sql, tenant, { email: "member@incassignees.test" });

    const res = await authed(app, token)
      .get("/v1/incidents/assignees")
      .expect(200);
    const emails = (res.body.assignees as { id: string; name: string }[]).map(
      (a) => a.id,
    );
    expect(emails).toContain(admin.id);
    expect(res.body.assignees.length).toBeGreaterThanOrEqual(2);

    // An auditor lacks incident:assign.
    const auditor = await createUser(sql, tenant, {
      email: "auditor@incassignees.test",
      password: "inc_assignees_a1",
    });
    await grantSystemRole(sql, auditor, "auditor");
    const aTok = (await loginAs(app, auditor)).accessToken;
    await authed(app, aTok).get("/v1/incidents/assignees").expect(403);
  });
});
