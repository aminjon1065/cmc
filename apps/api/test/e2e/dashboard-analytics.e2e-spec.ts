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
import { buildDailyTrend } from "../../src/modules/analytics/dashboard-trend";

/**
 * Dashboard analytics (P2.6 / ADR-0036). ClickHouse is faked so the suite never
 * touches CH. Covers the pure gap-fill, the tenant-scoped query, RBAC gating,
 * and graceful degradation when ClickHouse is off.
 */
describe("buildDailyTrend (pure)", () => {
  it("gap-fills a continuous window, oldest → newest", () => {
    const out = buildDailyTrend(
      [
        { day: "2026-06-01", count: 3 },
        { day: "2026-06-03", count: 5 },
      ],
      4,
      "2026-06-03",
    );
    expect(out).toEqual([
      { day: "2026-05-31", count: 0 },
      { day: "2026-06-01", count: 3 },
      { day: "2026-06-02", count: 0 },
      { day: "2026-06-03", count: 5 },
    ]);
  });

  it("returns all-zero when there is no data", () => {
    const out = buildDailyTrend([], 3, "2026-06-03");
    expect(out.map((p) => p.count)).toEqual([0, 0, 0]);
    expect(out).toHaveLength(3);
  });
});

describe("DashboardAnalyticsService — ClickHouse off", () => {
  it("degrades to source=unavailable with an empty trend", async () => {
    const noop: ClickHouseClient = {
      active: false,
      insert: async () => {},
      query: async () => [],
      ping: async () => false,
      close: async () => {},
    };
    const svc = new DashboardAnalyticsService(noop);
    const res = await svc.dashboard(
      "11111111-1111-1111-1111-111111111111",
      14,
    );
    expect(res.source).toBe("unavailable");
    expect(res.windowDays).toBe(14);
    expect(res.incidentTrend).toEqual([]);
  });
});

describe("GET /v1/analytics/dashboard", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  const queries: string[] = [];

  const fakeCh: ClickHouseClient = {
    active: true,
    insert: async () => {},
    query: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
      queries.push(sql);
      // Return "today" so the point always falls inside the window (robust
      // regardless of when the suite runs). Count as a string, like CH UInt64.
      const today = new Date().toISOString().slice(0, 10);
      return [{ bucket: today, count: "4" }] as unknown as T[];
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

  it("returns a gap-filled, tenant-scoped trend from ClickHouse", async () => {
    const res = await authed(app, token).get("/v1/analytics/dashboard?days=7");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("clickhouse");
    expect(res.body.windowDays).toBe(7);
    expect(res.body.incidentTrend).toHaveLength(7);
    // The 2026-06-01 datapoint (count 4) is present; the rest are gap-filled 0.
    const total = res.body.incidentTrend.reduce(
      (a: number, p: { count: number }) => a + p.count,
      0,
    );
    expect(total).toBe(4);
    // Tenant isolation: the query filters on this tenant + the daily MV.
    expect(queries[0]).toContain(tenantId);
    expect(queries[0]).toContain("incident_daily_stats_by_region");
  });

  it("clamps the window (default 14, max 90)", async () => {
    const def = await authed(app, token).get("/v1/analytics/dashboard");
    expect(def.body.windowDays).toBe(14);
    const huge = await authed(app, token).get(
      "/v1/analytics/dashboard?days=9999",
    );
    expect(huge.body.windowDays).toBe(90);
  });

  it("requires authentication", async () => {
    const request = (await import("supertest")).default;
    await request(app.getHttpServer())
      .get("/v1/analytics/dashboard")
      .expect(401);
  });

  it("rejects a user without incident:read (403)", async () => {
    const limited = await createUser(sql, { id: tenantId, slug: "x", name: "x" });
    const limitedToken = (await loginAs(app, limited)).accessToken;
    await authed(app, limitedToken)
      .get("/v1/analytics/dashboard")
      .expect(403);
  });
});
