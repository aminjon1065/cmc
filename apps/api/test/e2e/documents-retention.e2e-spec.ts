import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Retention + legal hold (P3.5 / ADR-0050): folder policy inherited down,
 * per-document override, the sweeper soft-deletes expired documents, and legal
 * hold suspends both the sweep and manual deletion.
 */
describe("Document retention + legal hold", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  let adminId: string;
  const bucket = "cmc-files";

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = user.id;
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE documents, folders RESTART IDENTITY CASCADE`);
  });

  const mkFolder = async (): Promise<string> => {
    const res = await authed(app, token)
      .post("/v1/folders")
      .send({ name: "Box" });
    expect(res.status).toBe(201);
    return res.body.folder.id as string;
  };

  /** Insert a ready document with a back-dated updated_at (so retention can fire). */
  async function insertDoc(opts: {
    folderId: string | null;
    agoDays: number;
    retentionDays?: number | null;
    legalHold?: boolean;
  }): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status,
         uploaded_by, folder_id, retention_days, legal_hold, created_at, updated_at)
      VALUES (${tenantId}, 'r.bin', 'application/octet-stream', ${bucket},
        ${"tenants/" + tenantId + "/documents/r"}, 'ready', ${adminId},
        ${opts.folderId}, ${opts.retentionDays ?? null}, ${opts.legalHold ?? false},
        now() - (${opts.agoDays}::int * interval '1 day'),
        now() - (${opts.agoDays}::int * interval '1 day'))
      RETURNING id`;
    return rows[0]!.id;
  }

  const sweep = async (): Promise<number> => {
    const res = await authed(app, token)
      .post("/v1/documents/retention/sweep")
      .expect(200);
    return res.body.swept as number;
  };

  const exists = async (id: string): Promise<boolean> => {
    const r = await authed(app, token).get(`/v1/documents/${id}`);
    return r.status === 200;
  };

  it("soft-deletes a document past the inherited folder retention", async () => {
    const f = await mkFolder();
    await authed(app, token)
      .patch(`/v1/folders/${f}/retention`)
      .send({ retentionDays: 1 })
      .expect(200);
    const doc = await insertDoc({ folderId: f, agoDays: 3 }); // 3d old, policy 1d → expired

    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await exists(doc)).toBe(false);
  });

  it("keeps documents with no applicable policy", async () => {
    const f = await mkFolder(); // no retention set
    const doc = await insertDoc({ folderId: f, agoDays: 3650 });
    await sweep();
    expect(await exists(doc)).toBe(true);
  });

  it("a per-document override beats the folder policy", async () => {
    const f = await mkFolder();
    await authed(app, token)
      .patch(`/v1/folders/${f}/retention`)
      .send({ retentionDays: 1 })
      .expect(200);
    // Folder says 1 day, but the doc overrides to 3650 → not expired.
    const doc = await insertDoc({ folderId: f, agoDays: 3, retentionDays: 3650 });
    await sweep();
    expect(await exists(doc)).toBe(true);
  });

  it("legal hold suspends the retention sweep", async () => {
    const f = await mkFolder();
    await authed(app, token)
      .patch(`/v1/folders/${f}/retention`)
      .send({ retentionDays: 1 })
      .expect(200);
    const held = await insertDoc({ folderId: f, agoDays: 3, legalHold: true });
    await sweep();
    expect(await exists(held)).toBe(true); // skipped
  });

  it("legal hold blocks manual deletion (403)", async () => {
    const doc = await insertDoc({ folderId: null, agoDays: 0, legalHold: true });
    await authed(app, token).delete(`/v1/documents/${doc}`).expect(403);

    // Lift the hold via the API → now deletable.
    await authed(app, token)
      .post(`/v1/documents/${doc}/legal-hold`)
      .send({ hold: false })
      .expect(200);
    await authed(app, token).delete(`/v1/documents/${doc}`).expect(204);
  });

  it("exposes retentionDays + legalHold on the document, set via the API", async () => {
    const doc = await insertDoc({ folderId: null, agoDays: 0 });
    const r1 = await authed(app, token)
      .post(`/v1/documents/${doc}/retention`)
      .send({ retentionDays: 30 })
      .expect(200);
    expect(r1.body.document.retentionDays).toBe(30);
    const r2 = await authed(app, token)
      .post(`/v1/documents/${doc}/legal-hold`)
      .send({ hold: true })
      .expect(200);
    expect(r2.body.document.legalHold).toBe(true);
  });
});
