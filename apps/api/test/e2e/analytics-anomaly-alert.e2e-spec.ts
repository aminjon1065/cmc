import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  CLICKHOUSE_CLIENT,
  type ClickHouseClient,
} from "../../src/modules/analytics/clickhouse.client";
import { AnomalyAlertService } from "../../src/modules/analytics/anomaly-alert.service";

/**
 * Proactive anomaly alerting (P4.8b / ADR-0066). ClickHouse is faked to emit a
 * clear spike; `scan()` is invoked directly (the interval is gated off under
 * jest). Verifies a `monitoring:read` holder gets an `analytics.anomaly`
 * notification, and that a re-scan is deduped (no second notification).
 */
describe("AnomalyAlertService.scan (P4.8b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenantId: string;
  let adminId: string;

  function daysAgo(n: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const fakeCh: ClickHouseClient = {
    active: true,
    insert: async () => {},
    query: async <T = Record<string, unknown>>(): Promise<T[]> =>
      Array.from({ length: 30 }, (_, i) => ({
        bucket: daysAgo(29 - i),
        count: i === 29 ? "60" : "5",
      })) as unknown as T[],
    ping: async () => true,
    close: async () => {},
  };

  async function anomalyNotifCount(userId: string): Promise<number> {
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM notifications
      WHERE user_id = ${userId} AND kind = 'analytics.anomaly'`;
    return rows[0]!.c;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(CLICKHOUSE_CLIENT).useValue(fakeCh),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql); // admin → monitoring:read
    tenantId = tenant.id;
    adminId = user.id;
  });

  afterAll(async () => {
    const keys = await redis.keys(`cmc:anomaly:${tenantId}:*`);
    if (keys.length) await redis.del(...keys);
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("notifies monitoring:read holders on a new anomaly, then dedups on re-scan", async () => {
    const svc = app.get(AnomalyAlertService);

    const first = await svc.scan();
    expect(first).toBeGreaterThanOrEqual(1);
    const afterFirst = await anomalyNotifCount(adminId);
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Re-scan: same (tenant, day, direction) → deduped, no new dispatch/row.
    const second = await svc.scan();
    expect(second).toBe(0);
    expect(await anomalyNotifCount(adminId)).toBe(afterFirst);
  });
});
