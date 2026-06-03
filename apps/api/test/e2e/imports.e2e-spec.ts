import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import AdmZip from "adm-zip";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
  seedPermissions,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";
import { ImportService } from "../../src/modules/imports/import.service";

/**
 * Build a minimal ESRI `.shp` main file (Point shapes only) by hand — no .dbf /
 * .shx needed (the `shapefile` reader reads the .shp sequentially; properties
 * default to {}). Dependency-free, so the shapefile path is tested with real
 * binary input. Coords are WGS84 (lng, lat).
 */
function buildPointShp(points: [number, number][]): Buffer {
  const fileLen = 100 + points.length * 28; // header + 28 bytes/record
  const buf = Buffer.alloc(fileLen);
  buf.writeInt32BE(9994, 0); // file code
  buf.writeInt32BE(fileLen / 2, 24); // file length (16-bit words)
  buf.writeInt32LE(1000, 28); // version
  buf.writeInt32LE(1, 32); // shape type: Point
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  buf.writeDoubleLE(Math.min(...xs), 36);
  buf.writeDoubleLE(Math.min(...ys), 44);
  buf.writeDoubleLE(Math.max(...xs), 52);
  buf.writeDoubleLE(Math.max(...ys), 60);
  let off = 100;
  points.forEach(([x, y], i) => {
    buf.writeInt32BE(i + 1, off); // record number (1-based)
    buf.writeInt32BE(10, off + 4); // content length: 20 bytes / 2
    buf.writeInt32LE(1, off + 8); // shape type: Point
    buf.writeDoubleLE(x, off + 12);
    buf.writeDoubleLE(y, off + 20);
    off += 28;
  });
  return buf;
}

/**
 * Bulk data import (P3.11 / ADR-0056): CSV→incidents + GeoJSON→GIS, per-row
 * validation with partial-commit + quarantine. The BullMQ worker is gated off in
 * tests, so we create the job via the API then drive `ImportService.runJob`
 * directly (mirrors the preview e2e). Real Postgres + MinIO.
 */
describe("Imports (/v1/imports, P3.11)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let imports: ImportService;
  let storage: StorageService;
  let bucket: string;
  let tenantId: string;
  let adminToken: string; // tenant_admin (all perms)
  let opToken: string; // operator (import:* + incident:create + gis_feature:write)
  let viewerToken: string; // role-less
  let escToken: string; // import:* but NOT incident:create (escalation probe)
  let otherToken: string;

  async function putSource(key: string, content: string): Promise<void> {
    await storage.putObject({
      bucket,
      key,
      body: Buffer.from(content, "utf8"),
      contentType: "text/plain",
    });
  }

  /** Create a job via the API (operator) then run it inline; return final job. */
  async function importNow(body: Record<string, unknown>) {
    const created = await authed(app, opToken)
      .post("/v1/imports")
      .send(body)
      .expect(201);
    const id = created.body.job.id as string;
    await imports.runJob(tenantId, id);
    const final = await authed(app, opToken).get(`/v1/imports/${id}`).expect(200);
    return final.body.job as {
      id: string;
      status: string;
      totalRows: number;
      insertedRows: number;
      failedRows: number;
      error: string | null;
    };
  }

  async function countIncidents(): Promise<number> {
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM incidents WHERE tenant_id = ${tenantId}`;
    return rows[0]!.c;
  }
  async function countFeatures(): Promise<number> {
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM gis_features WHERE tenant_id = ${tenantId}`;
    return rows[0]!.c;
  }

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    imports = app.get(ImportService);
    storage = app.get(StorageService);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES")!;
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminToken = (await loginAs(app, admin)).accessToken;

    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;

    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;

    // Escalation probe: a custom role with import:* but no target-domain write.
    const esc = await createUser(sql, tenant);
    await seedPermissions(sql);
    const [role] = await sql<{ id: string }[]>`
      INSERT INTO roles (tenant_id, slug, name, is_system)
      VALUES (${tenant.id}, 'import_only', 'Import Only', false)
      RETURNING id`;
    for (const key of ["import:run", "import:read"]) {
      const [domain, action] = key.split(":") as [string, string];
      await sql`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT ${role!.id}, p.id FROM permissions p
         WHERE p.domain = ${domain} AND p.action = ${action}`;
    }
    await sql`INSERT INTO user_roles (user_id, role_id, tenant_id)
      VALUES (${esc.id}, ${role!.id}, ${tenant.id})`;
    escToken = (await loginAs(app, esc)).accessToken;

    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("CSV→incidents: commits valid rows, quarantines the rest", async () => {
    const key = `imports/${randomUUID()}.csv`;
    await putSource(
      key,
      [
        "severity,type,region,summary,occurredAt",
        "3,flood,Sughd,Dam overflow,2026-01-01T00:00:00.000Z",
        "9,fire,Khatlon,Out-of-range severity,2026-01-02T00:00:00.000Z", // bad: severity>5
        "2,quake,GBAO,Tremor felt,2026-01-03T00:00:00.000Z",
        ",,,,", // bad: empty required fields
      ].join("\n"),
    );
    const before = await countIncidents();
    const job = await importNow({ kind: "csv_incidents", sourceKey: key });

    expect(job.status).toBe("completed");
    expect(job.totalRows).toBe(4);
    expect(job.insertedRows).toBe(2);
    expect(job.failedRows).toBe(2);
    expect(await countIncidents()).toBe(before + 2);

    const errs = await authed(app, opToken)
      .get(`/v1/imports/${job.id}/errors`)
      .expect(200);
    expect(errs.body.errors).toHaveLength(2);
    expect(errs.body.errors[0].rowNum).toBe(2);
    expect(String(errs.body.errors[0].reason)).toMatch(/severity/i);
  });

  it("GeoJSON→GIS: commits valid features, quarantines invalid geometry", async () => {
    const [layer] = await sql<{ id: string }[]>`
      INSERT INTO gis_layers (tenant_id, name) VALUES (${tenantId}, 'Imported')
      RETURNING id`;
    const key = `imports/${randomUUID()}.geojson`;
    await putSource(
      key,
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [68.78, 38.56] },
            properties: { name: "Dushanbe" },
          },
          { type: "Feature", geometry: null, properties: {} }, // bad: no geometry
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [71.0, 40.28] },
            properties: { name: "Khujand" },
          },
        ],
      }),
    );
    const before = await countFeatures();
    const job = await importNow({
      kind: "geojson_gis",
      sourceKey: key,
      targetId: layer!.id,
    });

    expect(job.status).toBe("completed");
    expect(job.totalRows).toBe(3);
    expect(job.insertedRows).toBe(2);
    expect(job.failedRows).toBe(1);
    expect(await countFeatures()).toBe(before + 2);
  });

  it("XLSX→incidents: parses the first sheet, same validate+quarantine path", async () => {
    const ws = XLSX.utils.json_to_sheet([
      {
        severity: 3,
        type: "flood",
        region: "Sughd",
        summary: "Excel flood",
        occurredAt: "2026-04-01T00:00:00.000Z",
      },
      {
        severity: 9, // bad: out of range → quarantine
        type: "fire",
        region: "Khatlon",
        summary: "Excel bad severity",
        occurredAt: "2026-04-02T00:00:00.000Z",
      },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const key = `imports/${randomUUID()}.xlsx`;
    await storage.putObject({
      bucket,
      key,
      body: buf,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const before = await countIncidents();
    const job = await importNow({ kind: "xlsx_incidents", sourceKey: key });
    expect(job.status).toBe("completed");
    expect(job.totalRows).toBe(2);
    expect(job.insertedRows).toBe(1);
    expect(job.failedRows).toBe(1);
    expect(await countIncidents()).toBe(before + 1);
  });

  it("Shapefile→GIS: unzips + parses .shp into features", async () => {
    const [layer] = await sql<{ id: string }[]>`
      INSERT INTO gis_layers (tenant_id, name) VALUES (${tenantId}, 'Shp Import')
      RETURNING id`;
    const zip = new AdmZip();
    zip.addFile(
      "cities.shp",
      buildPointShp([
        [68.78, 38.56],
        [71.0, 40.28],
      ]),
    );
    const key = `imports/${randomUUID()}.zip`;
    await storage.putObject({
      bucket,
      key,
      body: zip.toBuffer(),
      contentType: "application/zip",
    });

    const before = await countFeatures();
    const job = await importNow({
      kind: "shapefile_gis",
      sourceKey: key,
      targetId: layer!.id,
    });
    expect(job.status).toBe("completed");
    expect(job.totalRows).toBe(2);
    expect(job.insertedRows).toBe(2);
    expect(await countFeatures()).toBe(before + 2);
  });

  it("upload-init presigns a PUT, and the round-trip imports", async () => {
    const init = await authed(app, opToken)
      .post("/v1/imports/upload-init")
      .send({ filename: "round-trip.csv", contentType: "text/csv" })
      .expect(201);
    expect(init.body.sourceKey).toMatch(/^imports\//);
    expect(init.body.upload.method).toBe("PUT");

    const csv =
      "severity,type,region,summary,occurredAt\n1,note,Dushanbe,Uploaded via presign,2026-05-01T00:00:00.000Z\n";
    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: csv,
      headers: init.body.upload.headers,
    });
    expect(put.ok).toBe(true);

    const before = await countIncidents();
    const job = await importNow({
      kind: "csv_incidents",
      sourceKey: init.body.sourceKey,
    });
    expect(job.status).toBe("completed");
    expect(job.insertedRows).toBe(1);
    expect(await countIncidents()).toBe(before + 1);
  });

  it("fails the whole job when the source object is missing", async () => {
    const created = await authed(app, opToken)
      .post("/v1/imports")
      .send({ kind: "csv_incidents", sourceKey: `imports/${randomUUID()}.csv` })
      .expect(201);
    await imports.runJob(tenantId, created.body.job.id);
    const final = await authed(app, opToken)
      .get(`/v1/imports/${created.body.job.id}`)
      .expect(200);
    expect(final.body.job.status).toBe("failed");
    expect(String(final.body.job.error)).toMatch(/unreadable|not/i);
  });

  it("rejects gis imports with no target layer (400)", async () => {
    await authed(app, opToken)
      .post("/v1/imports")
      .send({ kind: "geojson_gis", sourceKey: "imports/x.geojson" })
      .expect(400);
    await authed(app, opToken)
      .post("/v1/imports")
      .send({ kind: "shapefile_gis", sourceKey: "imports/x.zip" })
      .expect(400);
  });

  it("enforces RBAC, the escalation guard, and tenant isolation", async () => {
    const key = `imports/${randomUUID()}.csv`;
    await putSource(key, "severity,type,region,summary,occurredAt\n");

    // viewer: no import:run / import:read.
    await authed(app, viewerToken)
      .post("/v1/imports")
      .send({ kind: "csv_incidents", sourceKey: key })
      .expect(403);
    await authed(app, viewerToken).get("/v1/imports").expect(403);

    // escalation probe: has import:run but NOT incident:create → 403.
    await authed(app, escToken)
      .post("/v1/imports")
      .send({ kind: "csv_incidents", sourceKey: key })
      .expect(403);

    // tenant isolation: another tenant can't see this tenant's job.
    const mine = await authed(app, opToken)
      .post("/v1/imports")
      .send({ kind: "csv_incidents", sourceKey: key })
      .expect(201);
    await authed(app, otherToken)
      .get(`/v1/imports/${mine.body.job.id}`)
      .expect(404);
  });
});
