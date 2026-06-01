import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createUser,
  createTenantWithAdmin,
  grantSystemRole,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  MailService,
  type MailMessage,
} from "../../src/common/mail/mail.service";

const OCCURRED = "2026-05-01T08:00:00.000Z";

/** Captures emails the dispatch would have sent (P1.6c). */
class CapturingMail {
  public sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<boolean> {
    this.sent.push(msg);
    return true;
  }
  reset(): void {
    this.sent = [];
  }
}

/**
 * In-app notifications (P1.6 / ADR-0024).
 *
 * Incident assign/transition fan out best-effort notifications to the right
 * recipients (excluding the actor); the center is self-scoped.
 */
describe("Notifications", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;

  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;
  let adminTok: string;
  let memberTok: string;
  const mail = new CapturingMail();

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(MailService).useValue(mail),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    mail.reset();
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "notif-tenant",
      email: "admin@notif.test",
      password: "notif_admin_pw_1",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, {
      email: "member@notif.test",
      password: "notif_member_pw1",
    });
    await grantSystemRole(sql, member, "operator");
    adminTok = (await loginAs(app, admin)).accessToken;
    memberTok = (await loginAs(app, member)).accessToken;
  });

  function createIncident(token: string) {
    return authed(app, token)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "Flood",
        region: "Khatlon",
        summary: "Vakhsh river breach",
        occurredAt: OCCURRED,
      });
  }

  it("assigning an incident notifies the assignee, not the actor", async () => {
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const memberInbox = await authed(app, memberTok)
      .get("/v1/notifications")
      .expect(200);
    expect(memberInbox.body.unreadCount).toBe(1);
    expect(memberInbox.body.notifications[0].kind).toBe("incident.assigned");
    expect(memberInbox.body.notifications[0].link).toBe(`/incidents/${id}`);

    // The actor (admin) is not notified of their own assignment action.
    const adminInbox = await authed(app, adminTok)
      .get("/v1/notifications")
      .expect(200);
    expect(adminInbox.body.unreadCount).toBe(0);
  });

  it("self-assignment notifies no one", async () => {
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: admin.id })
      .expect(200);
    const inbox = await authed(app, adminTok).get("/v1/notifications").expect(200);
    expect(inbox.body.unreadCount).toBe(0);
  });

  it("a transition notifies the reporter + assignee, excluding the actor", async () => {
    // admin reports + assigns to member.
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    // member (the assignee) triages → notifies the reporter (admin), not member.
    await authed(app, memberTok)
      .post(`/v1/incidents/${id}/transition`)
      .send({ to: "triaged" })
      .expect(200);

    const adminInbox = await authed(app, adminTok)
      .get("/v1/notifications")
      .expect(200);
    const kinds = (adminInbox.body.notifications as { kind: string }[]).map(
      (n) => n.kind,
    );
    expect(kinds).toContain("incident.transitioned");

    // member only has the earlier assignment (not their own transition).
    const memberInbox = await authed(app, memberTok)
      .get("/v1/notifications")
      .expect(200);
    expect(
      (memberInbox.body.notifications as { kind: string }[]).map((n) => n.kind),
    ).toEqual(["incident.assigned"]);
  });

  it("the center is self-scoped (no cross-user leakage)", async () => {
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    // member has 1; admin has 0 — neither sees the other's.
    const member1 = await authed(app, memberTok)
      .get("/v1/notifications")
      .expect(200);
    expect(member1.body.total).toBe(1);
    const admin0 = await authed(app, adminTok)
      .get("/v1/notifications")
      .expect(200);
    expect(admin0.body.total).toBe(0);
  });

  it("mark-read and read-all clear the unread count", async () => {
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);
    // Reassign away + back to generate a second notification.
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: null })
      .expect(200);
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    let inbox = await authed(app, memberTok).get("/v1/notifications").expect(200);
    expect(inbox.body.unreadCount).toBe(2);

    // Mark the first read.
    await authed(app, memberTok)
      .post(`/v1/notifications/${inbox.body.notifications[0].id}/read`)
      .expect(204);
    const count = await authed(app, memberTok)
      .get("/v1/notifications/unread-count")
      .expect(200);
    expect(count.body.unreadCount).toBe(1);

    // Read-all clears the rest.
    await authed(app, memberTok).post("/v1/notifications/read-all").expect(204);
    inbox = await authed(app, memberTok).get("/v1/notifications").expect(200);
    expect(inbox.body.unreadCount).toBe(0);
  });

  it("requires authentication", async () => {
    await authed(app, "not-a-token").get("/v1/notifications").expect(401);
  });

  // ---------- email channel + preferences (P1.6c) ----------

  it("assigning also emails the assignee", async () => {
    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(member.email);
    expect(mail.sent[0]!.subject).toContain("Assigned to you");
    // The email deep-links into the app (absolute URL).
    expect(mail.sent[0]!.html).toContain(`/incidents/${id}`);
  });

  it("the email pref off suppresses email but keeps the in-app row", async () => {
    await authed(app, memberTok)
      .put("/v1/notifications/preferences/incident.assigned")
      .send({ inApp: true, email: false })
      .expect(204);

    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    expect(mail.sent).toHaveLength(0); // email suppressed
    const inbox = await authed(app, memberTok).get("/v1/notifications").expect(200);
    expect(inbox.body.unreadCount).toBe(1); // in-app still delivered
  });

  it("the in-app pref off suppresses the row but still emails", async () => {
    await authed(app, memberTok)
      .put("/v1/notifications/preferences/incident.assigned")
      .send({ inApp: false, email: true })
      .expect(204);

    const id = (await createIncident(adminTok).expect(201)).body.incident.id;
    await authed(app, adminTok)
      .post(`/v1/incidents/${id}/assign`)
      .send({ userId: member.id })
      .expect(200);

    const inbox = await authed(app, memberTok).get("/v1/notifications").expect(200);
    expect(inbox.body.total).toBe(0); // no in-app row
    expect(mail.sent).toHaveLength(1); // email still sent
  });

  it("GET /notifications/preferences returns defaults (both on)", async () => {
    const res = await authed(app, memberTok)
      .get("/v1/notifications/preferences")
      .expect(200);
    const prefs = res.body.preferences as {
      kind: string;
      inApp: boolean;
      email: boolean;
    }[];
    expect(prefs.length).toBeGreaterThanOrEqual(2);
    expect(prefs.every((p) => p.inApp && p.email)).toBe(true);
  });

  it("an unknown preference kind is rejected", async () => {
    await authed(app, memberTok)
      .put("/v1/notifications/preferences/not.a.kind")
      .send({ inApp: true, email: false })
      .expect(400);
  });
});
