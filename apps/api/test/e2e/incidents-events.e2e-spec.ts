import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

const OCCURRED = "2026-05-01T08:00:00.000Z";

/**
 * Incidents as the first event producer (P2.1c / ADR-0031). Each lifecycle
 * action writes its domain event to the outbox IN THE SAME request transaction
 * as the state-change — so the event is exactly as durable as the change.
 */
describe("Incident events → outbox", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;
  let token: string;

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
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "inc-evt-tenant",
      email: "admin@incevt.test",
      password: "incevt_pw_1234",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, { email: "member@incevt.test" });
    token = (await loginAs(app, admin)).accessToken;
  });

  function createIncident(over: Record<string, unknown> = {}) {
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

  function outboxFor(aggregateId: string, eventType: string) {
    return sql<
      {
        aggregate_type: string;
        tenant_id: string | null;
        version: number;
        payload: Record<string, unknown>;
        published_at: Date | null;
      }[]
    >`SELECT * FROM outbox WHERE aggregate_id = ${aggregateId} AND event_type = ${eventType}`;
  }

  it("create emits incident.created atomically (pending publish)", async () => {
    const res = await createIncident().expect(201);
    const id = res.body.incident.id as string;

    const rows = await outboxFor(id, "created");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_type).toBe("incident");
    expect(rows[0]!.tenant_id).toBe(tenant.id);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.published_at).toBeNull();
    expect(rows[0]!.payload).toMatchObject({
      severity: 2,
      type: "Flood",
      region: "Khatlon",
      status: "reported",
      reportedBy: admin.id,
    });
  });

  it("transition emits incident.transitioned with from/to", async () => {
    const id = (await createIncident().expect(201)).body.incident.id as string;
    await authed(app, token)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(200);

    const rows = await outboxFor(id, "transitioned");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      from: "reported",
      to: "triaged",
      by: admin.id,
    });
  });

  it("assign emits incident.assigned", async () => {
    const id = (await createIncident().expect(201)).body.incident.id as string;
    await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const rows = await outboxFor(id, "assigned");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      assignedTo: member.id,
      by: admin.id,
    });
  });

  it("a full lifecycle produces an ordered event stream", async () => {
    const id = (await createIncident().expect(201)).body.incident.id as string;
    await authed(app, token)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(200);
    await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const rows = await sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox WHERE aggregate_id = ${id} ORDER BY seq ASC`;
    expect(rows.map((r) => r.event_type)).toEqual([
      "created",
      "transitioned",
      "assigned",
    ]);
  });
});
