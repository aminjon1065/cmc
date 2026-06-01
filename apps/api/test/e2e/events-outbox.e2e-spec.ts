import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { eventSubject } from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenant, type TestTenant } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { OutboxService } from "../../src/modules/events/outbox.service";
import { TenantDatabaseService } from "../../src/modules/database/tenant-database.service";

/**
 * Transactional outbox (P2.1 / ADR-0031). The headline guarantee: an event is
 * written in the SAME transaction as the state-change, so it commits or rolls
 * back together — no dual-write.
 */
describe("Transactional outbox", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let outbox: OutboxService;
  let db: TenantDatabaseService;
  let tenant: TestTenant;

  beforeAll(async () => {
    app = await buildTestApp();
    outbox = app.get(OutboxService);
    db = app.get(TenantDatabaseService);
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    tenant = await createTenant(sql, { slug: "outbox-tenant" });
  });

  it("subject builder maps an event to its NATS subject", () => {
    expect(
      eventSubject({
        tenantId: "abc",
        aggregateType: "incident",
        eventType: "created",
        version: 1,
      }),
    ).toBe("tenant.abc.incident.created.v1");
    expect(
      eventSubject({
        tenantId: null,
        aggregateType: "user",
        eventType: "registered",
        version: 2,
      }),
    ).toBe("tenant.system.user.registered.v2");
  });

  it("writes the event atomically with a committing transaction", async () => {
    await db.runForTenant(tenant.id, async () => {
      await outbox.publish({
        tenantId: tenant.id,
        aggregateType: "incident",
        aggregateId: "inc-1",
        eventType: "created",
        payload: { severity: 3 },
      });
    });

    const rows = await sql<
      {
        aggregate_type: string;
        event_type: string;
        version: number;
        payload: unknown;
        published_at: Date | null;
        seq: string;
      }[]
    >`SELECT * FROM outbox WHERE tenant_id = ${tenant.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aggregate_type).toBe("incident");
    expect(rows[0]!.event_type).toBe("created");
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.payload).toEqual({ severity: 3 });
    expect(rows[0]!.published_at).toBeNull(); // pending the relay
    expect(Number(rows[0]!.seq)).toBeGreaterThan(0);
  });

  it("rolls the event back when the surrounding transaction fails", async () => {
    await expect(
      db.runForTenant(tenant.id, async () => {
        await outbox.publish({
          tenantId: tenant.id,
          aggregateType: "incident",
          aggregateId: "inc-2",
          eventType: "created",
          payload: {},
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await sql`SELECT id FROM outbox WHERE tenant_id = ${tenant.id}`;
    expect(rows).toHaveLength(0); // the event died with the tx — no dual-write
  });

  it("opens its own transaction when there is no ambient one", async () => {
    const id = await outbox.publish({
      tenantId: tenant.id,
      aggregateType: "incident",
      aggregateId: "inc-3",
      eventType: "resolved",
      payload: { by: "system" },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await sql`SELECT id FROM outbox WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
  });

  it("supports tenant-less system events with a causation link", async () => {
    const causeId = "44444444-4444-4444-8444-444444444444";
    const id = await outbox.publish({
      tenantId: null,
      aggregateType: "user",
      aggregateId: "u1",
      eventType: "registered",
      payload: {},
      causationId: causeId,
    });
    const rows = await sql<
      { tenant_id: string | null; causation_id: string | null }[]
    >`SELECT tenant_id, causation_id FROM outbox WHERE id = ${id}`;
    expect(rows[0]!.tenant_id).toBeNull();
    expect(rows[0]!.causation_id).toBe(causeId);
  });
});
