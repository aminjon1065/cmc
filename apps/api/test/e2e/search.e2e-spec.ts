import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Cross-domain Postgres FTS (P2.11 / ADR-0041): `/v1/search` fans out tsvector
 * queries across incidents/cases/documents, filtered by the caller's read perms
 * and confined to the tenant by RLS, merged by score.
 */
describe("Search (/v1/search)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let viewerToken: string;
  let otherToken: string;
  let tenantId: string;
  let adminId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = admin.id;
    adminToken = (await loginAs(app, admin)).accessToken;
    const viewer = await createUser(sql, tenant); // role-less → no read perms
    viewerToken = (await loginAs(app, viewer)).accessToken;
    const other = await createTenantWithAdmin(sql);
    otherToken = (await loginAs(app, other.user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE case_activity, cases, incidents, documents RESTART IDENTITY CASCADE`,
    );
  });

  async function seedFloodData(): Promise<void> {
    await authed(app, adminToken)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "flood",
        region: "Khatlon",
        summary: "Flood emergency response near the river",
        occurredAt: "2026-06-02T08:00:00.000Z",
      })
      .expect(201);
    await authed(app, adminToken)
      .post("/v1/cases")
      .send({ title: "Flood damage investigation", type: "investigation" })
      .expect(201);
    // Insert a ready document directly (skip the upload flow). The owner is a
    // superuser → bypasses RLS for cross-tenant fixture setup.
    await sql`
      INSERT INTO documents
        (tenant_id, name, description, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, 'flood-report.pdf', 'Annual flood report',
        'application/pdf', 'cmc-files', ${"k-flood-" + tenantId}, 'ready', ${adminId})`;
  }

  it("matches across incidents, cases, and documents, ranked by score", async () => {
    await seedFloodData();

    const res = await authed(app, adminToken).get("/v1/search?q=flood");
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("flood");

    const types = new Set(
      res.body.results.map((r: { type: string }) => r.type),
    );
    expect(types.has("incident")).toBe(true);
    expect(types.has("case")).toBe(true);
    expect(types.has("document")).toBe(true);

    // Every result carries a numeric score; the list is non-increasing.
    const scores = res.body.results.map((r: { score: number }) => r.score);
    expect(scores.every((s: number) => typeof s === "number" && s > 0)).toBe(
      true,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("returns nothing for a term that doesn't match", async () => {
    await seedFloodData();
    const res = await authed(app, adminToken).get("/v1/search?q=earthquake");
    expect(res.body.results).toHaveLength(0);
  });

  it("filters to the domains the caller can read (role-less → empty)", async () => {
    await seedFloodData();
    const res = await authed(app, viewerToken).get("/v1/search?q=flood");
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it("returns empty for a blank query", async () => {
    await seedFloodData();
    const res = await authed(app, adminToken).get("/v1/search?q=");
    expect(res.body.results).toHaveLength(0);
  });

  it("isolates results across tenants (RLS)", async () => {
    await seedFloodData(); // tenant A
    const res = await authed(app, otherToken).get("/v1/search?q=flood");
    expect(res.body.results).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const request = (await import("supertest")).default;
    await request(app.getHttpServer()).get("/v1/search?q=flood").expect(401);
  });
});
