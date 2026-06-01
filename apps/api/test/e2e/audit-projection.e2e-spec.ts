import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuditProjectionService } from "../../src/modules/analytics/audit-projection.service";
import {
  CLICKHOUSE_CLIENT,
  type ClickHouseClient,
} from "../../src/modules/analytics/clickhouse.client";

/**
 * Audit → ClickHouse projection (P2.2 / ADR-0034). The ClickHouse client is
 * faked so the suite never touches CH. Tests the cursor-tail ETL: projects new
 * audit rows, advances the cursor, idempotent re-flush.
 */
describe("Audit ClickHouse projection", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let audit: AuditService;
  let projection: AuditProjectionService;
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

  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await audit.record({
        tenantId: null,
        actorType: "system",
        action: `test.audit.${i}`,
        resourceType: "test",
        resourceId: String(i),
        outcome: "success",
      });
    }
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(CLICKHOUSE_CLIENT).useValue(fakeCh),
    );
    audit = app.get(AuditService);
    projection = app.get(AuditProjectionService);
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

  it("projects audit rows into audit_events and advances the cursor", async () => {
    await seed(3);

    const res = await projection.flush();
    expect(res.projected).toBe(3);
    expect(res.cursorSeq).toBeGreaterThan(0);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("audit_events");
    expect(inserts[0]!.rows).toHaveLength(3);
    const row = inserts[0]!.rows[0]!;
    expect(row.actor_type).toBe("system");
    expect(row.action).toBe("test.audit.0");
    expect(row.outcome).toBe("success");
    expect(row.tenant_id).toBeNull(); // system event
    expect(typeof row.occurred_at).toBe("string");

    // Cursor persisted.
    const cur = await sql<{ last_seq: string }[]>`
      SELECT last_seq FROM projection_cursors WHERE consumer = 'audit-clickhouse'`;
    expect(Number(cur[0]!.last_seq)).toBe(res.cursorSeq);
  });

  it("re-flush projects nothing once the cursor is at the head", async () => {
    await seed(2);
    await projection.flush();
    const again = await projection.flush();
    expect(again.projected).toBe(0);
    expect(inserts).toHaveLength(1);
  });

  it("projects only rows added since the last flush", async () => {
    await seed(2);
    await projection.flush();
    inserts.length = 0;
    await seed(3);
    const res = await projection.flush();
    expect(res.projected).toBe(3);
    expect(inserts[0]!.rows).toHaveLength(3);
  });

  it("status reports cursor + pending", async () => {
    await seed(4);
    const before = await projection.status();
    expect(before.active).toBe(true);
    expect(before.cursorSeq).toBe(0);
    expect(before.pending).toBe(4);

    await projection.flush();
    expect((await projection.status()).pending).toBe(0);
  });
});
