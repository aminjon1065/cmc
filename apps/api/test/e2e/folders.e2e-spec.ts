import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Folder tree (P3.3 / ADR-0047): ltree CRUD, subtree repath on move, cycle
 * guard, soft-delete subtree (+ unfile documents), `folder:*` RBAC, and the
 * document↔folder linking (upload-init folderId, list filter, move, unfile).
 */
describe("Folders", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let viewerToken: string;
  let tenantId: string;
  let adminId: string;
  const bucket = "cmc-files";

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = admin.id;
    adminToken = (await loginAs(app, admin)).accessToken;
    const viewer = await createUser(sql, tenant); // role-less → no folder perms
    viewerToken = (await loginAs(app, viewer)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE documents, folders RESTART IDENTITY CASCADE`);
  });

  const mkFolder = async (
    body: Record<string, unknown>,
  ): Promise<{ id: string; parentId: string | null; depth: number }> => {
    const res = await authed(app, adminToken).post("/v1/folders").send(body);
    expect(res.status).toBe(201);
    return res.body.folder;
  };

  async function insertReadyDoc(folderId: string | null): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by, folder_id)
      VALUES (${tenantId}, 'f.bin', 'application/octet-stream', ${bucket},
        ${"tenants/" + tenantId + "/documents/x"}, 'ready', ${adminId}, ${folderId})
      RETURNING id`;
    return rows[0]!.id;
  }

  it("creates root + child folders with the right depth", async () => {
    const root = await mkFolder({ name: "Root" });
    expect(root.parentId).toBeNull();
    expect(root.depth).toBe(1);

    const child = await mkFolder({ name: "Child", parentId: root.id });
    expect(child.parentId).toBe(root.id);
    expect(child.depth).toBe(2);
  });

  it("lists the whole tree (parents before children)", async () => {
    const root = await mkFolder({ name: "A" });
    await mkFolder({ name: "B", parentId: root.id });
    const res = await authed(app, adminToken).get("/v1/folders").expect(200);
    const depths = res.body.folders.map((f: { depth: number }) => f.depth);
    expect(res.body.folders).toHaveLength(2);
    expect(depths[0]).toBeLessThanOrEqual(depths[1]); // path order → parent first
  });

  it("rename changes the name but not the depth/path", async () => {
    const f = await mkFolder({ name: "Old" });
    const res = await authed(app, adminToken)
      .patch(`/v1/folders/${f.id}`)
      .send({ name: "New" })
      .expect(200);
    expect(res.body.folder.name).toBe("New");
    expect(res.body.folder.depth).toBe(1);
  });

  it("move reparents and repaths the whole subtree", async () => {
    const p = await mkFolder({ name: "P" }); // depth 1
    const c = await mkFolder({ name: "C", parentId: p.id }); // depth 2
    const q = await mkFolder({ name: "Q" }); // depth 1

    // Move P (with child C) under Q → P depth 2, C depth 3.
    const moved = await authed(app, adminToken)
      .post(`/v1/folders/${p.id}/move`)
      .send({ parentId: q.id })
      .expect(200);
    expect(moved.body.folder.parentId).toBe(q.id);
    expect(moved.body.folder.depth).toBe(2);

    const cAfter = await authed(app, adminToken)
      .get(`/v1/folders/${c.id}`)
      .expect(200);
    expect(cAfter.body.folder.depth).toBe(3); // subtree repathed
    expect(cAfter.body.folder.parentId).toBe(p.id);
  });

  it("rejects moving a folder into its own descendant (cycle)", async () => {
    const p = await mkFolder({ name: "P" });
    const c = await mkFolder({ name: "C", parentId: p.id });
    await authed(app, adminToken)
      .post(`/v1/folders/${p.id}/move`)
      .send({ parentId: c.id })
      .expect(400);
  });

  it("soft-deletes the subtree and unfiles its documents", async () => {
    const p = await mkFolder({ name: "P" });
    const c = await mkFolder({ name: "C", parentId: p.id });
    const docId = await insertReadyDoc(c.id);

    await authed(app, adminToken).delete(`/v1/folders/${p.id}`).expect(204);

    // Whole subtree gone from the tree.
    const tree = await authed(app, adminToken).get("/v1/folders").expect(200);
    expect(tree.body.folders).toHaveLength(0);
    // The document survives, unfiled.
    const doc = await authed(app, adminToken)
      .get(`/v1/documents/${docId}`)
      .expect(200);
    expect(doc.body.document.folderId).toBeNull();
  });

  it("files a document on upload-init and rejects an unknown folder", async () => {
    const f = await mkFolder({ name: "Inbox" });
    const init = await authed(app, adminToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        folderId: f.id,
      });
    expect(init.status).toBe(201);
    expect(init.body.document.folderId).toBe(f.id);

    await authed(app, adminToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "b.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        folderId: "00000000-0000-0000-0000-000000000000",
      })
      .expect(400);
  });

  it("filters documents by folder and moves them between folders", async () => {
    const f1 = await mkFolder({ name: "F1" });
    const f2 = await mkFolder({ name: "F2" });
    const docId = await insertReadyDoc(f1.id);

    const inF1 = await authed(app, adminToken)
      .get(`/v1/documents?folderId=${f1.id}`)
      .expect(200);
    expect(inF1.body.documents.map((d: { id: string }) => d.id)).toContain(
      docId,
    );

    await authed(app, adminToken)
      .post(`/v1/documents/${docId}/move`)
      .send({ folderId: f2.id })
      .expect(200);
    const inF1After = await authed(app, adminToken)
      .get(`/v1/documents?folderId=${f1.id}`)
      .expect(200);
    expect(inF1After.body.documents).toHaveLength(0);

    // Unfile.
    const unfiled = await authed(app, adminToken)
      .post(`/v1/documents/${docId}/move`)
      .send({ folderId: null })
      .expect(200);
    expect(unfiled.body.document.folderId).toBeNull();
  });

  it("enforces folder:write (a role-less user gets 403)", async () => {
    await authed(app, viewerToken)
      .post("/v1/folders")
      .send({ name: "Nope" })
      .expect(403);
  });
});
