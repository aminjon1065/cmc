import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EventEnvelope } from "@cmc/contracts";
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
import { IncidentNotificationsConsumer } from "../../src/modules/incident-notifications/incident-notifications.consumer";

const OCCURRED = "2026-05-01T08:00:00.000Z";

/**
 * Incident events → notifications consumer (P2.4 / ADR-0032). Tests `handle()`
 * directly (NATS subscription is P2.4b). The assignee is set via SQL so the
 * consumer path is isolated from the inline dispatch (which fires here because
 * NATS is off in tests).
 */
describe("Incident notifications consumer", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let consumer: IncidentNotificationsConsumer;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp();
    consumer = app.get(IncidentNotificationsConsumer);
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
      tenantSlug: "inc-notif-tenant",
      email: "admin@incnotif.test",
      password: "incnotif_pw_12",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, { email: "member@incnotif.test" });
    token = (await loginAs(app, admin)).accessToken;
  });

  async function createIncident(): Promise<string> {
    const res = await authed(app, token)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "Flood",
        region: "Khatlon",
        summary: "Consumer test incident",
        occurredAt: OCCURRED,
      })
      .expect(201);
    return res.body.incident.id as string;
  }

  function envelope(
    incidentId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    return {
      id: randomUUID(),
      tenantId: tenant.id,
      aggregateType: "incident",
      aggregateId: incidentId,
      eventType,
      version: 1,
      payload,
      occurredAt: new Date().toISOString(),
      traceId: null,
      causationId: null,
    };
  }

  function notifsFor(userId: string) {
    return sql<{ kind: string }[]>`
      SELECT kind FROM notifications WHERE user_id = ${userId} ORDER BY created_at`;
  }

  it("handle(assigned) notifies the assignee and is idempotent", async () => {
    const id = await createIncident();
    // Set the assignee directly (bypass assign() so the inline path doesn't fire).
    await sql`UPDATE incidents SET assigned_to = ${member.id} WHERE id = ${id}`;

    const env = envelope(id, "assigned", {
      assignedTo: member.id,
      by: admin.id,
    });

    await consumer.handle(env);
    let rows = await notifsFor(member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("incident.assigned");

    // Redelivery of the same event → claim fails → no duplicate.
    await consumer.handle(env);
    rows = await notifsFor(member.id);
    expect(rows).toHaveLength(1);
  });

  it("handle(transitioned) notifies reporter + assignee, excluding the actor", async () => {
    const id = await createIncident(); // reporter = admin
    await sql`UPDATE incidents SET assigned_to = ${member.id} WHERE id = ${id}`;

    await consumer.handle(
      envelope(id, "transitioned", {
        from: "reported",
        to: "triaged",
        by: admin.id, // actor = admin (the reporter) → excluded
      }),
    );

    // Admin is the actor → not notified; member (assignee) is.
    expect(await notifsFor(admin.id)).toHaveLength(0);
    const memberRows = await notifsFor(member.id);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.kind).toBe("incident.transitioned");
  });

  it("ignores events it doesn't handle", async () => {
    const id = await createIncident();
    await consumer.handle(envelope(id, "created", { severity: 2 }));
    await consumer.handle({
      ...envelope(id, "assigned", { assignedTo: member.id, by: admin.id }),
      aggregateType: "user",
    });
    // Nothing claimed, nothing dispatched.
    const claims = await sql`SELECT 1 FROM consumed_events`;
    expect(claims).toHaveLength(0);
    expect(await notifsFor(member.id)).toHaveLength(0);
  });

  it("inline dispatch still fires when the event plane is off (no regression)", async () => {
    // NATS is off in tests → IncidentsService dispatches inline on assign().
    const id = await createIncident();
    await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const rows = await notifsFor(member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("incident.assigned");
  });
});
