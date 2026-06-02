import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  WorkflowResponseSchema,
  WorkflowsListResponseSchema,
  type WorkflowDefinition,
} from "@cmc/contracts";

/**
 * Workflow definition CRUD + DAG validation (P3.8a / ADR-0053). RLS confines
 * rows to the tenant; `workflow:*` gates each route; drafts may be saved
 * incomplete but enabling requires a valid graph.
 */
describe("Workflows (/v1/workflows, P3.8a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let viewerToken: string; // role-less → no workflow perms
  let otherToken: string;

  const validDef: WorkflowDefinition = {
    nodes: [
      { id: "n1", type: "start", position: { x: 0, y: 0 } },
      {
        id: "n2",
        type: "notify",
        position: { x: 0, y: 100 },
        config: { title: "Heads up", body: "Workflow ran." },
      },
      { id: "n3", type: "end", position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  };

  // No end node + the start has no outgoing edge → not runnable.
  const invalidDef: WorkflowDefinition = {
    nodes: [{ id: "n1", type: "start", position: { x: 0, y: 0 } }],
    edges: [],
  };

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    const other = await createTenantWithAdmin(sql);
    otherToken = (await loginAs(app, other.user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE workflows RESTART IDENTITY CASCADE`);
  });

  it("creates a draft, gets it, lists it, updates it, deletes it", async () => {
    const created = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "My flow", description: "draft" })
      .expect(201);
    const parsed = WorkflowResponseSchema.safeParse(created.body);
    expect(parsed.success).toBe(true);
    const id = created.body.workflow.id as string;
    expect(created.body.workflow.enabled).toBe(false);
    expect(created.body.workflow.version).toBe(1);
    expect(created.body.workflow.trigger).toEqual({ type: "manual" });

    const got = await authed(app, adminToken)
      .get(`/v1/workflows/${id}`)
      .expect(200);
    expect(got.body.workflow.name).toBe("My flow");

    const list = await authed(app, adminToken).get("/v1/workflows").expect(200);
    expect(WorkflowsListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.workflows).toHaveLength(1);

    const updated = await authed(app, adminToken)
      .patch(`/v1/workflows/${id}`)
      .send({ name: "Renamed", definition: validDef })
      .expect(200);
    expect(updated.body.workflow.name).toBe("Renamed");
    expect(updated.body.workflow.version).toBe(2); // bumped on definition change

    await authed(app, adminToken).delete(`/v1/workflows/${id}`).expect(204);
    await authed(app, adminToken).get(`/v1/workflows/${id}`).expect(404);
  });

  it("enables a workflow only when the graph is a valid DAG", async () => {
    // Enable with a valid graph → ok.
    const ok = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Runnable", definition: validDef, enabled: true })
      .expect(201);
    expect(ok.body.workflow.enabled).toBe(true);

    // Enable with an invalid graph → 400; the reason is in problem+json detail.
    const bad = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Broken", definition: invalidDef, enabled: true })
      .expect(400);
    expect(bad.body.detail).toContain("not runnable");

    // Saving the invalid graph as a draft (enabled omitted) is allowed.
    await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Draft broken", definition: invalidDef })
      .expect(201);
  });

  it("validates a definition without saving", async () => {
    const good = await authed(app, adminToken)
      .post("/v1/workflows/validate")
      .send({ definition: validDef })
      .expect(200);
    expect(good.body).toEqual({ valid: true, errors: [] });

    const bad = await authed(app, adminToken)
      .post("/v1/workflows/validate")
      .send({ definition: invalidDef })
      .expect(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.errors.length).toBeGreaterThan(0);

    // Validate accepts a condition graph with both branches.
    const conditionDef: WorkflowDefinition = {
      nodes: [
        { id: "s", type: "start", position: { x: 0, y: 0 } },
        {
          id: "c",
          type: "condition",
          position: { x: 0, y: 1 },
          config: { path: "severity", equals: "5" },
        },
        { id: "e1", type: "end", position: { x: -1, y: 2 } },
        { id: "e2", type: "end", position: { x: 1, y: 2 } },
      ],
      edges: [
        { id: "x1", source: "s", target: "c" },
        { id: "x2", source: "c", target: "e1", branch: "true" },
        { id: "x3", source: "c", target: "e2", branch: "false" },
      ],
    };
    const cond = await authed(app, adminToken)
      .post("/v1/workflows/validate")
      .send({ definition: conditionDef })
      .expect(200);
    expect(cond.body.valid).toBe(true);
  });

  it("rejects a malformed node config (Zod) with 400", async () => {
    const malformed = {
      nodes: [
        { id: "n1", type: "start", position: { x: 0, y: 0 } },
        // notify missing required `body`
        { id: "n2", type: "notify", position: { x: 0, y: 1 }, config: { title: "x" } },
        { id: "n3", type: "end", position: { x: 0, y: 2 } },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", target: "n3" },
      ],
    };
    await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Bad config", definition: malformed })
      .expect(400);
  });

  it("enforces workflow:* permissions", async () => {
    await authed(app, viewerToken).get("/v1/workflows").expect(403);
    await authed(app, viewerToken)
      .post("/v1/workflows")
      .send({ name: "Nope" })
      .expect(403);
  });

  it("isolates workflows across tenants (RLS → 404)", async () => {
    const created = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Tenant A flow" })
      .expect(201);
    const id = created.body.workflow.id as string;
    await authed(app, otherToken).get(`/v1/workflows/${id}`).expect(404);
    const otherList = await authed(app, otherToken)
      .get("/v1/workflows")
      .expect(200);
    expect(otherList.body.workflows).toHaveLength(0);
  });
});
