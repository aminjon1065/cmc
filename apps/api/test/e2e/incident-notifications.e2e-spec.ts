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
 * Incident events → notifications (ADR-0032; in-process events per ADR-0080).
 * IncidentsService emits a domain event on assign/transition; the
 * IncidentNotificationsListener (@OnEvent) dispatches notifications synchronously
 * within the request transaction. Driven end-to-end through the HTTP API.
 */
describe("Incident notifications (in-process events)", () => {
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
        summary: "Notification test incident",
        occurredAt: OCCURRED,
      })
      .expect(201);
    return res.body.incident.id as string;
  }

  function notifsFor(userId: string) {
    return sql<{ kind: string }[]>`
      SELECT kind FROM notifications WHERE user_id = ${userId} ORDER BY created_at`;
  }

  it("assign() emits an event that notifies the assignee", async () => {
    const id = await createIncident();
    await authed(app, token)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const rows = await notifsFor(member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("incident.assigned");
  });

  it("transition() emits an event that notifies reporter + assignee, excluding the actor", async () => {
    const id = await createIncident(); // reporter = admin
    // Assign to member directly so both reporter (admin) + assignee (member) exist.
    await sql`UPDATE incidents SET assigned_to = ${member.id} WHERE id = ${id}`;

    await authed(app, token)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(200);

    // Admin is the actor (and reporter) → excluded; member (assignee) is notified.
    expect(await notifsFor(admin.id)).toHaveLength(0);
    const memberRows = await notifsFor(member.id);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.kind).toBe("incident.transitioned");
  });
});
