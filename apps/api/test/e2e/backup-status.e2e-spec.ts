import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";

type Obj = { key: string; size: number; lastModified?: Date };

/**
 * Single-site DR backup-freshness (P5.DR / ADR-0074). StorageService is faked
 * (controls the backup object listing — no real MinIO objects needed). Covers a
 * fresh backup, a stale one (older than RPO), the empty case, and RBAC. The real
 * MinIO listing + the P0.5 nightly dumps are a live boundary.
 */
describe("Backup status (/v1/ops/backups/status, P5.DR)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let adminToken: string;

  let backupObjects: Obj[] = [];
  const fakeStorage = {
    listObjects: async () => backupObjects,
    probeReachable: async () => {},
  } as unknown as StorageService;

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(StorageService).useValue(fakeStorage),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const created = await createTenantWithAdmin(sql); // tenant_admin → monitoring:read
    tenant = created.tenant;
    adminToken = (await loginAs(app, created.user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("reports a fresh backup (within RPO)", async () => {
    backupObjects = [
      { key: "postgres/2026/06/cmc-old.dump", size: 100, lastModified: hoursAgo(50) },
      { key: "postgres/2026/06/cmc-new.dump", size: 200, lastModified: hoursAgo(2) },
      { key: "postgres/2026/06/notes.txt", size: 9, lastModified: hoursAgo(1) }, // ignored (not .dump)
    ];
    const res = await authed(app, adminToken)
      .get("/v1/ops/backups/status")
      .expect(200);
    expect(res.body).toMatchObject({
      count: 2, // only .dump files
      latestKey: "postgres/2026/06/cmc-new.dump",
      fresh: true,
    });
    expect(res.body.ageHours).toBeLessThanOrEqual(3);
    expect(res.body.rpoHours).toBeGreaterThan(0);
    expect(typeof res.body.latestAt).toBe("string");
  });

  it("reports NOT fresh when the newest backup is older than RPO", async () => {
    backupObjects = [
      { key: "postgres/2026/05/cmc-stale.dump", size: 200, lastModified: hoursAgo(200) },
    ];
    const res = await authed(app, adminToken)
      .get("/v1/ops/backups/status")
      .expect(200);
    expect(res.body.fresh).toBe(false);
    expect(res.body.count).toBe(1);
    expect(res.body.ageHours).toBeGreaterThan(res.body.rpoHours);
  });

  it("reports no backups (empty) as not fresh", async () => {
    backupObjects = [];
    const res = await authed(app, adminToken)
      .get("/v1/ops/backups/status")
      .expect(200);
    expect(res.body).toMatchObject({
      count: 0,
      latestKey: null,
      latestAt: null,
      ageHours: null,
      fresh: false,
    });
  });

  it("RBAC: a role-less viewer cannot read backup status (403)", async () => {
    const viewer = await createUser(sql, tenant);
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    await authed(app, viewerToken)
      .get("/v1/ops/backups/status")
      .expect(403);
  });
});
