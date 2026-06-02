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
import {
  TEMPORAL_CLIENT,
  type StartWorkflowInput,
  type TemporalClient,
} from "../../src/modules/temporal/temporal-client";
import type { WorkflowDefinition } from "@cmc/contracts";

/**
 * Workflow run engine (P3.8b / ADR-0053). The Temporal client is faked
 * (capturing) so the starter's behaviour — snapshot a run row + start the
 * interpreter — is observable without a real worker. Actual execution is the
 * live smoke.
 */
describe("Workflow runs (P3.8b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let opToken: string; // operator → workflow:read + workflow:run, no write
  let viewerToken: string; // role-less → nothing
  let otherToken: string;

  const started: StartWorkflowInput[] = [];
  const fakeTemporal: TemporalClient = {
    active: true,
    async start(input) {
      started.push(input);
    },
    async cancel() {},
    async close() {},
  };

  const validDef: WorkflowDefinition = {
    nodes: [
      { id: "n1", type: "start", position: { x: 0, y: 0 } },
      {
        id: "n2",
        type: "notify",
        position: { x: 0, y: 1 },
        config: { title: "Ran", body: "Workflow executed." },
      },
      { id: "n3", type: "end", position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  };

  async function createWorkflow(def: WorkflowDefinition): Promise<string> {
    const res = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({ name: "Runnable", definition: def, enabled: true })
      .expect(201);
    return res.body.workflow.id as string;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(TEMPORAL_CLIENT).useValue(fakeTemporal),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    started.length = 0;
    await sql.unsafe(
      `TRUNCATE workflow_runs, workflows RESTART IDENTITY CASCADE`,
    );
  });

  it("creates a run row and starts the interpreter execution", async () => {
    const id = await createWorkflow(validDef);
    const res = await authed(app, opToken)
      .post(`/v1/workflows/${id}/run`)
      .send({ input: { severity: "5" } })
      .expect(202);

    const runId = res.body.run.id as string;
    expect(res.body.run.status).toBe("pending");
    expect(res.body.run.trigger).toBe("manual");
    expect(res.body.run.input).toEqual({ severity: "5" });

    // The interpreter was started with the run id + the snapshotted graph.
    expect(started).toHaveLength(1);
    expect(started[0]!.workflowType).toBe("workflowInterpreter");
    expect(started[0]!.workflowId).toBe(`wf-run:${runId}`);
    const arg = started[0]!.args[0] as {
      runId: string;
      definition: WorkflowDefinition;
    };
    expect(arg.runId).toBe(runId);
    expect(arg.definition.nodes).toHaveLength(3);
  });

  it("lists runs and fetches a single run", async () => {
    const id = await createWorkflow(validDef);
    const run = await authed(app, adminToken)
      .post(`/v1/workflows/${id}/run`)
      .send({})
      .expect(202);
    const runId = run.body.run.id as string;

    const list = await authed(app, adminToken)
      .get(`/v1/workflows/${id}/runs`)
      .expect(200);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].id).toBe(runId);

    const single = await authed(app, adminToken)
      .get(`/v1/workflows/runs/${runId}`)
      .expect(200);
    expect(single.body.run.id).toBe(runId);
  });

  it("refuses to run a workflow whose graph isn't a valid DAG (400)", async () => {
    // Draft with an incomplete graph (saved disabled, so allowed).
    const draft = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({
        name: "Draft",
        definition: {
          nodes: [{ id: "n1", type: "start", position: { x: 0, y: 0 } }],
          edges: [],
        },
      })
      .expect(201);
    await authed(app, adminToken)
      .post(`/v1/workflows/${draft.body.workflow.id}/run`)
      .send({})
      .expect(400);
    expect(started).toHaveLength(0);
  });

  it("enforces workflow:run + tenant isolation", async () => {
    const id = await createWorkflow(validDef);
    // viewer lacks workflow:run.
    await authed(app, viewerToken)
      .post(`/v1/workflows/${id}/run`)
      .send({})
      .expect(403);
    // other tenant can't see the workflow → 404.
    await authed(app, otherToken)
      .post(`/v1/workflows/${id}/run`)
      .send({})
      .expect(404);
  });
});
