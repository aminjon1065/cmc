import { randomUUID } from "crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  TEMPORAL_CLIENT,
  type StartWorkflowInput,
  type TemporalClient,
} from "../../src/modules/temporal/temporal-client";
import { WorkflowEventConsumer } from "../../src/modules/workflows/workflow-event.consumer";
import type { EventEnvelope, WorkflowDefinition } from "@cmc/contracts";

/**
 * Event-triggered workflow auto-start (P3.8c / ADR-0053). The consumer's pure
 * `handle()` is exercised directly (the NATS subscription reuses the proven
 * P2.4b pattern); the Temporal client is faked so starts are observable.
 */
describe("Workflow event triggers (P3.8c)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let consumer: WorkflowEventConsumer;
  let adminToken: string;
  let tenantId: string;

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
        config: { title: "Auto", body: "event-triggered", toUserId: undefined },
      },
      { id: "n3", type: "end", position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
    ],
  };

  function envelope(
    over: Partial<EventEnvelope> & {
      aggregateType: string;
      eventType: string;
    },
  ): EventEnvelope {
    return {
      id: randomUUID(),
      tenantId,
      aggregateId: randomUUID(),
      version: 1,
      payload: {},
      occurredAt: "2026-06-02T00:00:00.000Z",
      traceId: null,
      causationId: null,
      ...over,
    };
  }

  async function createEventWorkflow(
    event: string,
    enabled: boolean,
  ): Promise<string> {
    const res = await authed(app, adminToken)
      .post("/v1/workflows")
      .send({
        name: `on ${event}`,
        definition: validDef,
        enabled,
        trigger: { type: "event", event },
      })
      .expect(201);
    return res.body.workflow.id as string;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(TEMPORAL_CLIENT).useValue(fakeTemporal),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    consumer = app.get(WorkflowEventConsumer);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminToken = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    started.length = 0;
    await sql.unsafe(
      `TRUNCATE workflow_runs, workflows, consumed_events RESTART IDENTITY CASCADE`,
    );
  });

  async function runsOf(workflowId: string) {
    const res = await authed(app, adminToken)
      .get(`/v1/workflows/${workflowId}/runs`)
      .expect(200);
    return res.body.runs as Array<{
      trigger: string;
      status: string;
      input: Record<string, unknown>;
    }>;
  }

  it("auto-starts a bound workflow when a matching event arrives", async () => {
    const id = await createEventWorkflow("incident.created", true);
    await consumer.handle(
      envelope({
        aggregateType: "incident",
        eventType: "created",
        payload: { severity: "5" },
      }),
    );

    expect(started).toHaveLength(1);
    expect(started[0]!.workflowType).toBe("workflowInterpreter");
    const arg = started[0]!.args[0] as { input: Record<string, unknown> };
    expect(arg.input).toEqual({ severity: "5" });

    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("event");
    expect(runs[0]!.input).toEqual({ severity: "5" });
  });

  it("is idempotent on the event id (redelivery → one run)", async () => {
    const id = await createEventWorkflow("incident.created", true);
    const env = envelope({ aggregateType: "incident", eventType: "created" });
    await consumer.handle(env);
    await consumer.handle(env); // redelivery
    expect(started).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("ignores events with no bound workflow (no dedup row written)", async () => {
    await createEventWorkflow("incident.created", true);
    await consumer.handle(
      envelope({ aggregateType: "case", eventType: "created" }),
    );
    expect(started).toHaveLength(0);
    const ledger = await sql`SELECT count(*)::int AS n FROM consumed_events`;
    expect(ledger[0]!.n).toBe(0);
  });

  it("does not trigger a disabled workflow", async () => {
    const id = await createEventWorkflow("incident.created", false);
    await consumer.handle(
      envelope({ aggregateType: "incident", eventType: "created" }),
    );
    expect(started).toHaveLength(0);
    expect(await runsOf(id)).toHaveLength(0);
  });

  it("starts every workflow bound to the same event", async () => {
    const a = await createEventWorkflow("incident.created", true);
    const b = await createEventWorkflow("incident.created", true);
    await consumer.handle(
      envelope({ aggregateType: "incident", eventType: "created" }),
    );
    expect(started).toHaveLength(2);
    expect(await runsOf(a)).toHaveLength(1);
    expect(await runsOf(b)).toHaveLength(1);
  });
});
