import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Cases (P2.10 / ADR-0040): CRUD, the status state machine, assignment, the
 * activity timeline (created / status_changed / assigned / comment), stats,
 * RBAC, and tenant isolation (RLS).
 */
describe("Cases", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let viewerToken: string;
  let otherToken: string;
  let responderId: string;
  let otherUserId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const responder = await createUser(sql, tenant);
    responderId = responder.id;
    const viewer = await createUser(sql, tenant); // role-less → no case perms
    viewerToken = (await loginAs(app, viewer)).accessToken;

    const other = await createTenantWithAdmin(sql);
    otherToken = (await loginAs(app, other.user)).accessToken;
    otherUserId = other.user.id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE case_activity, cases RESTART IDENTITY CASCADE`);
  });

  async function createCase(
    token: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await authed(app, token)
      .post("/v1/cases")
      .send({ title: "Flooding investigation", type: "investigation", ...over });
    expect(res.status).toBe(201);
    return res.body.case.id as string;
  }

  it("creates, reads, updates, and soft-deletes a case", async () => {
    const create = await authed(app, adminToken)
      .post("/v1/cases")
      .send({ title: "Bridge collapse", type: "structural", priority: 1 });
    expect(create.status).toBe(201);
    expect(create.body.case.status).toBe("open");
    expect(create.body.case.priority).toBe(1);
    expect(create.body.case.openedBy).not.toBeNull();
    const id = create.body.case.id as string;

    const list = await authed(app, adminToken).get("/v1/cases");
    expect(list.body.cases.map((c: { id: string }) => c.id)).toContain(id);
    expect(list.body.total).toBeGreaterThanOrEqual(1);

    const upd = await authed(app, adminToken)
      .patch(`/v1/cases/${id}`)
      .send({ priority: 3, title: "Bridge collapse (downgraded)" });
    expect(upd.body.case.priority).toBe(3);

    await authed(app, adminToken).delete(`/v1/cases/${id}`).expect(204);
    await authed(app, adminToken).get(`/v1/cases/${id}`).expect(404);
  });

  it("enforces the status state machine + records resolvedAt", async () => {
    const id = await createCase(adminToken);

    // open → closed is not allowed.
    await authed(app, adminToken)
      .post(`/v1/cases/${id}/transition`)
      .send({ to: "closed" })
      .expect(400);

    // open → in_progress → resolved (resolved sets resolvedAt).
    await authed(app, adminToken)
      .post(`/v1/cases/${id}/transition`)
      .send({ to: "in_progress" })
      .expect(200);
    const resolved = await authed(app, adminToken)
      .post(`/v1/cases/${id}/transition`)
      .send({ to: "resolved", note: "fixed" });
    expect(resolved.body.case.status).toBe("resolved");
    expect(resolved.body.case.resolvedAt).not.toBeNull();

    // reopen → in_progress clears resolvedAt.
    const reopened = await authed(app, adminToken)
      .post(`/v1/cases/${id}/transition`)
      .send({ to: "in_progress" });
    expect(reopened.body.case.resolvedAt).toBeNull();
  });

  it("assigns to a tenant user and rejects cross-tenant / unassign", async () => {
    const id = await createCase(adminToken);

    const assigned = await authed(app, adminToken)
      .post(`/v1/cases/${id}/assign`)
      .send({ userId: responderId });
    expect(assigned.body.case.assignedTo?.id).toBe(responderId);

    // Cross-tenant user is not a member here → 400.
    await authed(app, adminToken)
      .post(`/v1/cases/${id}/assign`)
      .send({ userId: otherUserId })
      .expect(400);

    const unassigned = await authed(app, adminToken)
      .post(`/v1/cases/${id}/assign`)
      .send({ userId: null });
    expect(unassigned.body.case.assignedTo).toBeNull();
  });

  it("builds an activity timeline (created / status_changed / assigned / comment)", async () => {
    const id = await createCase(adminToken);
    await authed(app, adminToken)
      .post(`/v1/cases/${id}/transition`)
      .send({ to: "in_progress" });
    await authed(app, adminToken)
      .post(`/v1/cases/${id}/assign`)
      .send({ userId: responderId });

    const comment = await authed(app, adminToken)
      .post(`/v1/cases/${id}/comment`)
      .send({ body: "Investigating on site" });
    expect(comment.status).toBe(201);
    expect(comment.body.kind).toBe("comment");
    expect(comment.body.body).toBe("Investigating on site");
    expect(comment.body.actor).not.toBeNull();

    const act = await authed(app, adminToken).get(`/v1/cases/${id}/activity`);
    const kinds = act.body.activities.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["created", "status_changed", "assigned", "comment"]),
    );
    // Newest first.
    expect(act.body.activities[0].kind).toBe("comment");
  });

  it("reports stats (openTotal + byStatus)", async () => {
    await createCase(adminToken);
    const id2 = await createCase(adminToken);
    await authed(app, adminToken)
      .post(`/v1/cases/${id2}/transition`)
      .send({ to: "cancelled" });

    const stats = await authed(app, adminToken).get("/v1/cases/stats");
    expect(stats.status).toBe(200);
    expect(stats.body.openTotal).toBe(1); // one open, one cancelled
    expect(stats.body.byStatus.open).toBe(1);
    expect(stats.body.byStatus.cancelled).toBe(1);
  });

  it("requires case permissions (role-less user → 403)", async () => {
    await authed(app, viewerToken).get("/v1/cases").expect(403);
    await authed(app, viewerToken)
      .post("/v1/cases")
      .send({ title: "x", type: "y" })
      .expect(403);
  });

  it("isolates cases across tenants (RLS)", async () => {
    const id = await createCase(adminToken); // tenant A

    const otherList = await authed(app, otherToken).get("/v1/cases");
    expect(otherList.body.cases).toHaveLength(0);
    await authed(app, otherToken).get(`/v1/cases/${id}`).expect(404);
  });
});
