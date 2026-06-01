import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EventEnvelope } from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { OutboxService } from "../../src/modules/events/outbox.service";
import { RelayService } from "../../src/modules/events/relay.service";
import {
  EVENT_PUBLISHER,
  type EventPublisher,
} from "../../src/modules/events/event-publisher";

type Captured = { subject: string; envelope: EventEnvelope; msgId: string };

/**
 * Outbox→NATS relay (P2.1b / ADR-0031). The `EventPublisher` is faked so the
 * suite never touches NATS (the `nats` package isn't even loaded — NATS_ENABLED
 * is false and the factory only dynamic-imports it when enabled). Real NATS
 * publish + consume is proven in the live smoke.
 */
describe("Outbox→NATS relay", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let outbox: OutboxService;
  let relay: RelayService;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;
  const captured: Captured[] = [];

  const fakePublisher: EventPublisher = {
    active: true,
    init: async () => {},
    publish: async (subject, envelope, msgId) => {
      captured.push({ subject, envelope, msgId });
    },
    close: async () => {},
  };

  function emit(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return outbox.publish({
      tenantId: tenant.id,
      aggregateType,
      aggregateId,
      eventType,
      payload,
    });
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(EVENT_PUBLISHER).useValue(fakePublisher),
    );
    outbox = app.get(OutboxService);
    relay = app.get(RelayService);
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    captured.length = 0;
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "relay-tenant",
      email: "admin@relay.test",
      password: "relay_pw_12345",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, {
      email: "member@relay.test",
      password: "relay_pw_12345",
    });
    await grantSystemRole(sql, member, "operator");
  });

  it("publishes unpublished rows to their subjects and stamps published_at", async () => {
    await emit("incident", "inc-1", "created", { severity: 3 });
    await emit("incident", "inc-1", "transitioned", { to: "triaged" });

    const res = await relay.flush();
    expect(res.published).toBe(2);
    expect(captured).toHaveLength(2);

    expect(captured[0]!.subject).toBe(`tenant.${tenant.id}.incident.created.v1`);
    expect(captured[0]!.msgId).toBe(captured[0]!.envelope.id); // dedup key
    expect(captured[0]!.envelope.aggregateType).toBe("incident");
    expect(captured[0]!.envelope.eventType).toBe("created");
    expect(captured[0]!.envelope.payload).toEqual({ severity: 3 });

    const rows = await sql<{ published_at: Date | null }[]>`
      SELECT published_at FROM outbox WHERE tenant_id = ${tenant.id}`;
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
  });

  it("re-flush publishes nothing once everything is stamped", async () => {
    await emit("incident", "i", "created", {});
    await relay.flush();
    const again = await relay.flush();
    expect(again.published).toBe(0);
    expect(captured).toHaveLength(1);
  });

  it("publishes only rows added since the last flush, in seq order", async () => {
    await emit("incident", "a", "created", {});
    await emit("incident", "b", "created", {});
    await relay.flush();
    captured.length = 0;

    await emit("incident", "c", "created", {});
    const res = await relay.flush();
    expect(res.published).toBe(1);
    expect(captured.map((c) => c.envelope.aggregateId)).toEqual(["c"]);
  });

  it("preserves seq order within a batch", async () => {
    await emit("incident", "a", "created", {});
    await emit("incident", "b", "created", {});
    await emit("incident", "c", "created", {});
    await relay.flush();
    expect(captured.map((c) => c.envelope.aggregateId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("status reports pending + active + stream", async () => {
    await emit("incident", "i", "created", {});
    const before = await relay.status();
    expect(before.active).toBe(true);
    expect(before.pending).toBe(1);
    expect(before.stream).toBe("CMC_EVENTS");

    await relay.flush();
    expect((await relay.status()).pending).toBe(0);
  });

  it("relay endpoints: 401 anon, 403 non-admin, 200 admin", async () => {
    await emit("incident", "i", "created", {});

    await request(app.getHttpServer())
      .get("/v1/events/relay/status")
      .expect(401);

    const m = await loginAs(app, member);
    await authed(app, m.accessToken)
      .post("/v1/events/relay/flush")
      .expect(403);

    const a = await loginAs(app, admin);
    const s = await authed(app, a.accessToken)
      .get("/v1/events/relay/status")
      .expect(200);
    expect(typeof s.body.pending).toBe("number");

    const f = await authed(app, a.accessToken)
      .post("/v1/events/relay/flush")
      .expect(200);
    expect(f.body.published).toBeGreaterThanOrEqual(1);
  });
});
