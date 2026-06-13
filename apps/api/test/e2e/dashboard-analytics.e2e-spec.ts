import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { buildDailyTrend } from "../../src/modules/analytics/dashboard-trend";

/**
 * Dashboard analytics (ToR v2.0 §5; ADR-0080) — now **PostgreSQL**-backed (the
 * ClickHouse store + anomaly plane were removed). Covers the pure gap-fill, the
 * RLS + region-scoped incident-trend query, window clamping, and RBAC gating.
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

describe("GET /v1/analytics/dashboard (Postgres)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;

  /** ISO timestamp `offset` whole days before now (UTC). */
  const daysAgo = (offset: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString();
  };

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    token = (await loginAs(app, user)).accessToken;
    // 2 incidents today, 1 yesterday (both inside a 7-day window), 1 thirty
    // days ago (outside). Inserted via the owner connection (bypasses RLS).
    await sql`
      INSERT INTO incidents (tenant_id, severity, type, region, summary, occurred_at)
      VALUES
        (${tenantId}, 2, 'fire',  'Dushanbe', 'a', ${daysAgo(0)}),
        (${tenantId}, 3, 'flood', 'Sughd',    'b', ${daysAgo(0)}),
        (${tenantId}, 1, 'quake', 'GBAO',     'c', ${daysAgo(1)}),
        (${tenantId}, 4, 'storm', 'Khatlon',  'd', ${daysAgo(30)})
    `;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("returns a gap-filled, RLS-scoped incident trend from Postgres", async () => {
    const res = await authed(app, token).get("/v1/analytics/dashboard?days=7");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("postgres");
    expect(res.body.windowDays).toBe(7);
    expect(res.body.incidentTrend).toHaveLength(7);
    // Only the 3 in-window incidents count; the 30-day-old one is excluded.
    const total = res.body.incidentTrend.reduce(
      (a: number, p: { count: number }) => a + p.count,
      0,
    );
    expect(total).toBe(3);
    // Newest point (today) carries the 2 incidents occurred today.
    expect(res.body.incidentTrend.at(-1).count).toBe(2);
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
