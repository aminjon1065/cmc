import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { EventEnvelope } from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { IncidentProjectionConsumer } from "../../src/modules/analytics/incident-projection.consumer";
import {
  CLICKHOUSE_CLIENT,
  type ClickHouseClient,
} from "../../src/modules/analytics/clickhouse.client";

const TENANT = "55555555-5555-4555-8555-555555555555";

/**
 * Incident → ClickHouse projection consumer (P2.5 / ADR-0033). The ClickHouse
 * client is faked so the suite never touches CH (the driver isn't loaded —
 * CLICKHOUSE_ENABLED is false). Tests the handler: insert shape, idempotency,
 * filtering.
 */
describe("Incident projection consumer", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let consumer: IncidentProjectionConsumer;
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];

  const fakeCh: ClickHouseClient = {
    active: true,
    insert: async (table, rows) => {
      inserts.push({ table, rows });
    },
    query: async () => [],
    ping: async () => true,
    close: async () => {},
  };

  function envelope(
    eventType: string,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    return {
      id: randomUUID(),
      tenantId: TENANT,
      aggregateType: "incident",
      aggregateId: randomUUID(),
      eventType,
      version: 1,
      payload,
      occurredAt: "2026-06-01T10:00:00.000Z",
      traceId: null,
      causationId: null,
    };
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(CLICKHOUSE_CLIENT).useValue(fakeCh),
    );
    consumer = app.get(IncidentProjectionConsumer);
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    inserts.length = 0;
    await truncateAll(sql, redis);
  });

  it("projects incident.created into incident_events and is idempotent", async () => {
    const env = envelope("created", {
      severity: 4,
      region: "Sughd",
      type: "Fire",
      status: "reported",
      occurredAt: "2026-04-15T06:30:00.000Z", // the incident's real-world time
    });

    await consumer.handle(env);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("incident_events");
    const row = inserts[0]!.rows[0]!;
    expect(row.event_type).toBe("created");
    expect(row.tenant_id).toBe(TENANT);
    expect(row.incident_id).toBe(env.aggregateId);
    expect(row.severity).toBe(4);
    expect(row.region).toBe("Sughd");
    expect(row.status).toBe("reported");
    // buckets by the incident's occurrence time (payload), not the event time
    expect(row.occurred_at).toBe("2026-04-15 06:30:00.000");

    // Redelivery → dedup → no second insert.
    await consumer.handle(env);
    expect(inserts).toHaveLength(1);
  });

  it("projects incident.transitioned with the new status", async () => {
    await consumer.handle(
      envelope("transitioned", { from: "reported", to: "triaged" }),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.rows[0]!.event_type).toBe("transitioned");
    expect(inserts[0]!.rows[0]!.status).toBe("triaged");
  });

  it("ignores events it doesn't project", async () => {
    await consumer.handle(envelope("assigned", { assignedTo: "x", by: "y" }));
    await consumer.handle({
      ...envelope("created", { region: "X" }),
      aggregateType: "user",
    });
    expect(inserts).toHaveLength(0);
    const claims = await sql`SELECT 1 FROM consumed_events`;
    expect(claims).toHaveLength(0); // unhandled events aren't even claimed
  });
});
