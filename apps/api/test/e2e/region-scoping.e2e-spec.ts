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

const OCCURRED = "2026-06-01T08:00:00.000Z";

/**
 * Hard region scoping on incidents + cases (P4.6b / ADR-0064). A regional user
 * (no `region:all`) sees + acts only on rows in their own region; the head
 * office (tenant_admin → `region:all`) sees every region. Create stamps the
 * creator's region. Backward-compat (null-region) is covered by the other
 * domain specs (their actors are region-less and still see region-less rows).
 */
describe("Region scoping (P4.6b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string; // tenant_admin → region:all
  let opDToken: string; // operator, region = Dushanbe
  let opSToken: string; // operator, region = Sughd
  let dushanbeId: string;
  let sughdId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;

    const regions = await sql<{ id: string; code: string }[]>`
      SELECT id, code FROM regions WHERE tenant_id = ${tenant.id}`;
    dushanbeId = regions.find((r) => r.code === "DUSHANBE")!.id;
    sughdId = regions.find((r) => r.code === "SUGHD")!.id;

    const opD = await createUser(sql, tenant);
    await grantSystemRole(sql, opD, "operator");
    await sql`UPDATE users SET region_id = ${dushanbeId} WHERE id = ${opD.id}`;
    opDToken = (await loginAs(app, opD)).accessToken;

    const opS = await createUser(sql, tenant);
    await grantSystemRole(sql, opS, "operator");
    await sql`UPDATE users SET region_id = ${sughdId} WHERE id = ${opS.id}`;
    opSToken = (await loginAs(app, opS)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  async function createIncident(token: string, regionLabel: string) {
    const res = await authed(app, token)
      .post("/v1/incidents")
      .send({
        severity: 3,
        type: "Flood",
        region: regionLabel,
        summary: `Incident in ${regionLabel}`,
        occurredAt: OCCURRED,
      })
      .expect(201);
    return res.body.incident as { id: string; regionId: string | null };
  }

  async function createCase(token: string, title: string) {
    const res = await authed(app, token)
      .post("/v1/cases")
      .send({ title, type: "investigation" })
      .expect(201);
    return res.body.case as { id: string; regionId: string | null };
  }

  it("incidents: create stamps the creator's region; regional users see only their own; HQ sees all", async () => {
    const iD = await createIncident(opDToken, "Dushanbe");
    const iS = await createIncident(opSToken, "Sughd");
    expect(iD.regionId).toBe(dushanbeId);
    expect(iS.regionId).toBe(sughdId);

    const listD = await authed(app, opDToken).get("/v1/incidents").expect(200);
    const idsD = listD.body.incidents.map((i: { id: string }) => i.id);
    expect(idsD).toContain(iD.id);
    expect(idsD).not.toContain(iS.id);

    const listS = await authed(app, opSToken).get("/v1/incidents").expect(200);
    const idsS = listS.body.incidents.map((i: { id: string }) => i.id);
    expect(idsS).toContain(iS.id);
    expect(idsS).not.toContain(iD.id);

    const listAdmin = await authed(app, adminToken)
      .get("/v1/incidents")
      .expect(200);
    const idsAdmin = listAdmin.body.incidents.map((i: { id: string }) => i.id);
    expect(idsAdmin).toEqual(expect.arrayContaining([iD.id, iS.id]));
  });

  it("incidents: a regional user 404s on an out-of-region detail; HQ can read it", async () => {
    const iS = await createIncident(opSToken, "Sughd");
    await authed(app, opDToken).get(`/v1/incidents/${iS.id}`).expect(404);
    await authed(app, adminToken).get(`/v1/incidents/${iS.id}`).expect(200);
    // The owning region can read its own.
    await authed(app, opSToken).get(`/v1/incidents/${iS.id}`).expect(200);
  });

  it("cases: create stamps region; regional isolation on list + detail; HQ sees all", async () => {
    const cD = await createCase(opDToken, "Dushanbe case");
    const cS = await createCase(opSToken, "Sughd case");
    expect(cD.regionId).toBe(dushanbeId);
    expect(cS.regionId).toBe(sughdId);

    const listD = await authed(app, opDToken).get("/v1/cases").expect(200);
    const idsD = listD.body.cases.map((c: { id: string }) => c.id);
    expect(idsD).toContain(cD.id);
    expect(idsD).not.toContain(cS.id);

    // Cross-region detail + activity are hidden (404).
    await authed(app, opDToken).get(`/v1/cases/${cS.id}`).expect(404);
    await authed(app, opDToken).get(`/v1/cases/${cS.id}/activity`).expect(404);

    // HQ sees both.
    const listAdmin = await authed(app, adminToken).get("/v1/cases").expect(200);
    const idsAdmin = listAdmin.body.cases.map((c: { id: string }) => c.id);
    expect(idsAdmin).toEqual(expect.arrayContaining([cD.id, cS.id]));
    await authed(app, adminToken).get(`/v1/cases/${cS.id}`).expect(200);
  });
});
