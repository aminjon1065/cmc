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

const DUSHANBE = { type: "Point", coordinates: [68.78, 38.56] };
const FARAWAY = { type: "Point", coordinates: [71.5, 40.3] };

/**
 * GIS layers + features (P2.7 / ADR-0037). Real PostGIS: geometry round-trips as
 * GeoJSON, bbox filtering uses the GIST index, RBAC gates layer-edit vs
 * feature-write vs read, and RLS isolates tenants.
 */
describe("GIS layers + features", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let otherToken: string;
  let tenantAId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantAId = tenant.id;
    adminToken = (await loginAs(app, admin)).accessToken;

    const operator = await createUser(sql, tenant);
    await grantSystemRole(sql, operator, "operator");
    operatorToken = (await loginAs(app, operator)).accessToken;

    const viewer = await createUser(sql, tenant); // role-less → no gis perms
    viewerToken = (await loginAs(app, viewer)).accessToken;

    const { user: otherAdmin } = await createTenantWithAdmin(sql);
    otherToken = (await loginAs(app, otherAdmin)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    // Reset only GIS rows between cases; keep tenants/users/roles.
    await sql.unsafe(`TRUNCATE gis_features, gis_layers RESTART IDENTITY CASCADE`);
  });

  async function createLayer(token: string, name = "Flood zones"): Promise<string> {
    const res = await authed(app, token)
      .post("/v1/gis/layers")
      .send({ name, kind: "point" });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  // ---------- layers ----------

  it("creates, reads, updates, and soft-deletes a layer (admin)", async () => {
    const create = await authed(app, adminToken)
      .post("/v1/gis/layers")
      .send({ name: "Shelters", kind: "point", isPublic: true });
    expect(create.status).toBe(201);
    expect(create.body.name).toBe("Shelters");
    expect(create.body.kind).toBe("point");
    expect(create.body.featureCount).toBe(0);
    const id = create.body.id as string;

    const list = await authed(app, adminToken).get("/v1/gis/layers");
    expect(list.body.layers.map((l: { id: string }) => l.id)).toContain(id);

    const got = await authed(app, adminToken).get(`/v1/gis/layers/${id}`);
    expect(got.body.isPublic).toBe(true);

    const upd = await authed(app, adminToken)
      .patch(`/v1/gis/layers/${id}`)
      .send({ name: "Shelters v2" });
    expect(upd.body.name).toBe("Shelters v2");

    await authed(app, adminToken).delete(`/v1/gis/layers/${id}`).expect(204);
    await authed(app, adminToken).get(`/v1/gis/layers/${id}`).expect(404);
  });

  // ---------- features + geometry round-trip ----------

  it("creates a feature and round-trips its GeoJSON geometry", async () => {
    const layerId = await createLayer(adminToken);

    const create = await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: DUSHANBE, properties: { label: "HQ" } });
    expect(create.status).toBe(201);
    expect(create.body.geometry.type).toBe("Point");
    expect(create.body.geometry.coordinates).toEqual([68.78, 38.56]);
    expect(create.body.properties).toEqual({ label: "HQ" });
    const fid = create.body.id as string;

    const got = await authed(app, adminToken).get(`/v1/gis/features/${fid}`);
    expect(got.body.geometry.coordinates).toEqual([68.78, 38.56]);

    // Layer's featureCount reflects it.
    const layer = await authed(app, adminToken).get(`/v1/gis/layers/${layerId}`);
    expect(layer.body.featureCount).toBe(1);

    const upd = await authed(app, adminToken)
      .patch(`/v1/gis/features/${fid}`)
      .send({ geometry: FARAWAY });
    expect(upd.body.geometry.coordinates).toEqual([71.5, 40.3]);

    await authed(app, adminToken).delete(`/v1/gis/features/${fid}`).expect(204);
    await authed(app, adminToken).get(`/v1/gis/features/${fid}`).expect(404);
  });

  it("filters features by bbox (GIST envelope)", async () => {
    const layerId = await createLayer(adminToken);
    await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: DUSHANBE });
    await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: FARAWAY });

    const all = await authed(app, adminToken).get(
      `/v1/gis/layers/${layerId}/features`,
    );
    expect(all.body.total).toBe(2);

    // bbox around Dushanbe → only that one.
    const near = await authed(app, adminToken).get(
      `/v1/gis/layers/${layerId}/features?bbox=68,38,69,39`,
    );
    expect(near.body.features).toHaveLength(1);
    expect(near.body.features[0].geometry.coordinates).toEqual([68.78, 38.56]);

    // bbox over open ocean → none.
    const none = await authed(app, adminToken).get(
      `/v1/gis/layers/${layerId}/features?bbox=0,0,1,1`,
    );
    expect(none.body.features).toHaveLength(0);
  });

  it("rejects a malformed bbox + invalid GeoJSON (400)", async () => {
    const layerId = await createLayer(adminToken);
    await authed(app, adminToken)
      .get(`/v1/gis/layers/${layerId}/features?bbox=1,2,3`)
      .expect(400);
    await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: { type: "Nonsense", coordinates: [1, 2] } })
      .expect(400);
  });

  // ---------- RBAC ----------

  it("enforces gis permissions (edit vs write vs read)", async () => {
    // Operator lacks gis:layer:edit → cannot create a layer.
    await authed(app, operatorToken)
      .post("/v1/gis/layers")
      .send({ name: "nope" })
      .expect(403);

    // Admin creates the layer; operator (has gis:feature:write) can add features.
    const layerId = await createLayer(adminToken);
    await authed(app, operatorToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: DUSHANBE })
      .expect(201);

    // Role-less viewer has no gis perms → read is denied.
    await authed(app, viewerToken).get("/v1/gis/layers").expect(403);
  });

  // ---------- tenant isolation ----------

  it("isolates layers across tenants (RLS)", async () => {
    const layerId = await createLayer(adminToken); // tenant A

    const otherList = await authed(app, otherToken).get("/v1/gis/layers");
    expect(otherList.body.layers).toHaveLength(0);

    await authed(app, otherToken).get(`/v1/gis/layers/${layerId}`).expect(404);
    expect(tenantAId).toBeDefined();
  });

  // ---------- vector tiles (P2.8) ----------

  it("serves a non-empty MVT tile covering the feature", async () => {
    const layerId = await createLayer(adminToken);
    await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: DUSHANBE });

    // Tile 0/0/0 is the whole world → contains the feature.
    const res = await authed(app, adminToken).get(
      `/v1/gis/tiles/${layerId}/0/0/0.mvt`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.mapbox-vector-tile",
    );
    expect(res.headers["cache-control"]).toContain("max-age");
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
  });

  it("returns 204 for a tile with no features in range", async () => {
    const layerId = await createLayer(adminToken);
    await authed(app, adminToken)
      .post(`/v1/gis/layers/${layerId}/features`)
      .send({ geometry: DUSHANBE }); // eastern hemisphere

    // z=1 x=0 = western hemisphere → no feature → empty tile.
    await authed(app, adminToken)
      .get(`/v1/gis/tiles/${layerId}/1/0/0.mvt`)
      .expect(204);
  });

  it("rejects out-of-range tile coordinates (400)", async () => {
    const layerId = await createLayer(adminToken);
    // z=2 → valid x/y are 0..3; x=9 is out of range.
    await authed(app, adminToken)
      .get(`/v1/gis/tiles/${layerId}/2/9/0.mvt`)
      .expect(400);
  });

  it("requires gis_layer:read for tiles", async () => {
    const layerId = await createLayer(adminToken);
    await authed(app, viewerToken)
      .get(`/v1/gis/tiles/${layerId}/0/0/0.mvt`)
      .expect(403);
  });
});
