import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  CLICKHOUSE_CLIENT,
  type ClickHouseClient,
} from "../../src/modules/analytics/clickhouse.client";
import { DashboardAnalyticsService } from "../../src/modules/analytics/dashboard-analytics.service";
import { detectAnomalies } from "../../src/modules/analytics/anomaly-detector";

/**
 * Realtime analytics — anomaly detection (P4.8a / ADR-0066). The detector is a
 * pure function (unit-tested directly); the endpoint runs against a faked
 * ClickHouse so the suite never touches CH. Covers spike/dip/flat/short series,
 * graceful degradation, the tenant-scoped query, and RBAC.
 */
function pt(value: number, i: number) {
  return { bucket: `d${i}`, value };
}

describe("detectAnomalies (pure)", () => {
  it("flags a spike off a quiet baseline", () => {
    const series = [...Array(10)].map((_, i) => pt(5, i)).concat(pt(50, 10));
    const out = detectAnomalies(series, { window: 7, zThreshold: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("spike");
    expect(out[0]!.value).toBe(50);
    expect(out[0]!.z).toBeGreaterThanOrEqual(3);
  });

  it("flags a dip off a high baseline", () => {
    const series = [...Array(8)].map((_, i) => pt(50, i)).concat(pt(2, 8));
    const out = detectAnomalies(series, { window: 7, zThreshold: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe("dip");
  });

  it("flags nothing on a flat baseline (stddev floor)", () => {
    const series = [...Array(15)].map((_, i) => pt(5, i));
    expect(detectAnomalies(series, { window: 7, zThreshold: 3 })).toEqual([]);
  });

  it("flags nothing when the series is shorter than the window", () => {
    const series = [pt(1, 0), pt(99, 1), pt(2, 2)];
    expect(detectAnomalies(series, { window: 7, zThreshold: 3 })).toEqual([]);
  });
});

describe("DashboardAnalyticsService.anomalies — ClickHouse off", () => {
  it("degrades to source=unavailable with no anomalies", async () => {
    const noop: ClickHouseClient = {
      active: false,
      insert: async () => {},
      query: async () => [],
      ping: async () => false,
      close: async () => {},
    };
    const svc = new DashboardAnalyticsService(noop);
    const res = await svc.anomalies("11111111-1111-1111-1111-111111111111", {
      days: 30,
    });
    expect(res.source).toBe("unavailable");
    expect(res.anomalies).toEqual([]);
    expect(res.baselineWindow).toBeGreaterThan(0);
  });
});

describe("GET /v1/analytics/anomalies", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  const queries: string[] = [];

  function daysAgo(n: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // 30 quiet days (count 5) ending today, with a clear spike (60) on the last.
  const fakeCh: ClickHouseClient = {
    active: true,
    insert: async () => {},
    query: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
      queries.push(sql);
      return Array.from({ length: 30 }, (_, i) => ({
        bucket: daysAgo(29 - i),
        count: i === 29 ? "60" : "5",
      })) as unknown as T[];
    },
    ping: async () => true,
    close: async () => {},
  };

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(CLICKHOUSE_CLIENT).useValue(fakeCh),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(() => {
    queries.length = 0;
  });

  it("detects the spike from a ClickHouse-backed, tenant-scoped series", async () => {
    const res = await authed(app, token).get("/v1/analytics/anomalies");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("clickhouse");
    expect(res.body.baselineWindow).toBe(7);
    expect(res.body.zThreshold).toBe(3);
    const spike = res.body.anomalies.find(
      (a: { direction: string }) => a.direction === "spike",
    );
    expect(spike).toBeDefined();
    expect(spike.count).toBe(60);
    expect(spike.day).toBe(daysAgo(0));
    // Tenant isolation + correct source table.
    expect(queries[0]).toContain(tenantId);
    expect(queries[0]).toContain("incident_daily_stats_by_region");
  });

  it("honours a custom z threshold (high z → no anomalies)", async () => {
    const res = await authed(app, token).get("/v1/analytics/anomalies?z=999");
    expect(res.body.zThreshold).toBe(999);
    expect(res.body.anomalies).toEqual([]);
  });

  it("requires authentication", async () => {
    const request = (await import("supertest")).default;
    await request(app.getHttpServer())
      .get("/v1/analytics/anomalies")
      .expect(401);
  });

  it("rejects a user without incident:read (403)", async () => {
    const limited = await createUser(sql, { id: tenantId, slug: "x", name: "x" });
    const limitedToken = (await loginAs(app, limited)).accessToken;
    await authed(app, limitedToken)
      .get("/v1/analytics/anomalies")
      .expect(403);
  });
});
