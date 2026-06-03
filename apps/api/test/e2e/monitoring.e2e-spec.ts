import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Operational Monitoring Center (P4.3a / ADR-0062). The wall summary + audit_log
 * replay are pure Postgres aggregations; these drive them against real data and
 * verify RBAC (`monitoring:read`) + tenant isolation.
 */
describe("Monitoring center (P4.3a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let opToken: string;
  let viewerToken: string;
  let otherToken: string;

  const incident = (severity: number, summary: string) => ({
    severity,
    type: "flood",
    region: "Khatlon",
    summary,
    occurredAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant } = await createTenantWithAdmin(sql);
    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator"); // incident:* + monitoring:read
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;

    // Seed operational activity (also writes incident.created to audit_log).
    await authed(app, opToken)
      .post("/v1/incidents")
      .send(incident(1, "Dam overflow"))
      .expect(201);
    await authed(app, opToken)
      .post("/v1/incidents")
      .send(incident(3, "Road blocked"))
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("summary reflects active incidents + recent events", async () => {
    const res = await authed(app, opToken)
      .get("/v1/monitoring/summary")
      .expect(200);
    const s = res.body.summary;
    expect(s.incidents.active).toBeGreaterThanOrEqual(2);
    expect(s.incidents.bySeverity["1"]).toBeGreaterThanOrEqual(1);
    expect(s.incidents.bySeverity["3"]).toBeGreaterThanOrEqual(1);
    expect(
      s.recentIncidents.map((i: { summary: string }) => i.summary),
    ).toEqual(expect.arrayContaining(["Dam overflow", "Road blocked"]));
    expect(s.recentEvents.length).toBeGreaterThan(0);
    expect(
      s.recentEvents.some((e: { action: string }) =>
        e.action.includes("incident"),
      ),
    ).toBe(true);
    expect(typeof s.videoRoomsOpen).toBe("number");
    expect(s.generatedAt).toMatch(/^\d{4}-/);
  });

  it("replay returns the audit timeline over a window, ascending", async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const res = await authed(app, opToken)
      .get(`/v1/monitoring/replay?from=${from}&to=${to}`)
      .expect(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    const times = res.body.events.map((e: { occurredAt: string }) =>
      Date.parse(e.occurredAt),
    );
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted); // ascending
    expect(
      res.body.events.some((e: { action: string }) =>
        e.action.includes("incident"),
      ),
    ).toBe(true);
  });

  it("rejects bad replay windows", async () => {
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 1000).toISOString();
    await authed(app, opToken)
      .get(`/v1/monitoring/replay?from=${now}&to=${earlier}`)
      .expect(400);
    await authed(app, opToken)
      .get(`/v1/monitoring/replay?from=not-a-date&to=${now}`)
      .expect(400);
  });

  it("enforces monitoring:read (viewer → 403)", async () => {
    await authed(app, viewerToken).get("/v1/monitoring/summary").expect(403);
    await authed(app, viewerToken).get("/v1/monitoring/replay").expect(403);
  });

  it("isolates per tenant (another tenant sees zero of our incidents)", async () => {
    const res = await authed(app, otherToken)
      .get("/v1/monitoring/summary")
      .expect(200);
    expect(res.body.summary.incidents.active).toBe(0);
    expect(res.body.summary.recentIncidents).toEqual([]);
  });
});
