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
import { FolderAccessService } from "../../src/modules/folders/folder-access.service";

/**
 * Per-folder permission inheritance (P3.3b / ADR-0048): restricted subtrees are
 * visible only to grant-holders (user OR role grants, inherited down the tree) +
 * folder:manage admins + the folder's creator. read vs write levels. Documents
 * in restricted folders are filtered/blocked accordingly.
 */
describe("Folder access (restricted subtrees + grants)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let access: FolderAccessService;
  let tenantId: string;
  let adminId: string;
  let adminToken: string; // tenant_admin → folder:manage (bypass)
  let aToken: string; // operator
  let aId: string;
  let bToken: string; // operator (non-grantee)
  let operatorRoleId: string;
  const bucket = "cmc-files";

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    access = app.get(FolderAccessService);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = admin.id;
    adminToken = (await loginAs(app, admin)).accessToken;

    const a = await createUser(sql, tenant);
    aId = a.id;
    await grantSystemRole(sql, a, "operator");
    aToken = (await loginAs(app, a)).accessToken;

    const b = await createUser(sql, tenant);
    operatorRoleId = await grantSystemRole(sql, b, "operator");
    bToken = (await loginAs(app, b)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE folder_grants, documents, folders RESTART IDENTITY CASCADE`,
    );
    await access.invalidateTenant(tenantId); // clear the decision cache
  });

  const mkFolder = async (
    token: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const res = await authed(app, token).post("/v1/folders").send(body);
    expect(res.status).toBe(201);
    return res.body.folder.id as string;
  };

  const restrict = (id: string) =>
    authed(app, adminToken)
      .patch(`/v1/folders/${id}/restrict`)
      .send({ restricted: true })
      .expect(200);

  const grant = (id: string, body: Record<string, unknown>) =>
    authed(app, adminToken).post(`/v1/folders/${id}/grants`).send(body).expect(201);

  const treeIds = async (token: string): Promise<string[]> => {
    const res = await authed(app, token).get("/v1/folders").expect(200);
    return res.body.folders.map((f: { id: string }) => f.id);
  };

  async function insertReadyDoc(folderId: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by, folder_id)
      VALUES (${tenantId}, 'secret.bin', 'application/octet-stream', ${bucket},
        ${"tenants/" + tenantId + "/documents/s"}, 'ready', ${adminId}, ${folderId})
      RETURNING id`;
    return rows[0]!.id;
  }

  it("hides a restricted folder from non-grantees; admin (folder:manage) bypasses", async () => {
    const r = await mkFolder(adminToken, { name: "Secret" });
    await restrict(r);

    expect(await treeIds(bToken)).not.toContain(r); // operator, no grant
    await authed(app, bToken).get(`/v1/folders/${r}`).expect(404);
    expect(await treeIds(adminToken)).toContain(r); // admin bypass
  });

  it("a user grant unlocks the restricted subtree for that user", async () => {
    const r = await mkFolder(adminToken, { name: "Secret" });
    await restrict(r);
    expect(await treeIds(aToken)).not.toContain(r);

    await grant(r, { subjectType: "user", subjectId: aId, access: "read" });
    expect(await treeIds(aToken)).toContain(r);
    expect(await treeIds(bToken)).not.toContain(r); // unaffected
  });

  it("a role grant unlocks it for everyone in the role", async () => {
    const r = await mkFolder(adminToken, { name: "Secret" });
    await restrict(r);
    await grant(r, {
      subjectType: "role",
      subjectId: operatorRoleId,
      access: "read",
    });
    // Both operators (a + b) now see it via the role grant.
    expect(await treeIds(aToken)).toContain(r);
    expect(await treeIds(bToken)).toContain(r);
  });

  it("a read grant does not confer write (creating a child needs write)", async () => {
    const r = await mkFolder(adminToken, { name: "Secret" });
    await restrict(r);
    await grant(r, { subjectType: "user", subjectId: aId, access: "read" });

    // read grant → can see, cannot create a child.
    await authed(app, aToken)
      .post("/v1/folders")
      .send({ name: "child", parentId: r })
      .expect(403);

    // upgrade to write → now allowed.
    await grant(r, { subjectType: "user", subjectId: aId, access: "write" });
    await authed(app, aToken)
      .post("/v1/folders")
      .send({ name: "child", parentId: r })
      .expect(201);
  });

  it("documents in a restricted folder are filtered + blocked for non-grantees", async () => {
    const r = await mkFolder(adminToken, { name: "Secret" });
    await restrict(r);
    const docId = await insertReadyDoc(r);

    // non-grantee: not in list, 404 on get
    const bList = await authed(app, bToken).get("/v1/documents").expect(200);
    expect(bList.body.documents.map((d: { id: string }) => d.id)).not.toContain(
      docId,
    );
    await authed(app, bToken).get(`/v1/documents/${docId}`).expect(404);

    // grant a → visible
    await grant(r, { subjectType: "user", subjectId: aId, access: "read" });
    const aList = await authed(app, aToken).get("/v1/documents").expect(200);
    expect(aList.body.documents.map((d: { id: string }) => d.id)).toContain(
      docId,
    );
    // admin always sees it
    await authed(app, adminToken).get(`/v1/documents/${docId}`).expect(200);
  });

  it("the folder creator keeps access even after it's restricted", async () => {
    // 'a' creates the folder (a is creator), then admin restricts it.
    const r = await mkFolder(aToken, { name: "Mine" });
    await restrict(r);
    expect(await treeIds(aToken)).toContain(r); // creator bypass
    expect(await treeIds(bToken)).not.toContain(r);
  });
});
