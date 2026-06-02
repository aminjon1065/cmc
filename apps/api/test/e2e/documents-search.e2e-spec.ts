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
import {
  SEARCH_INDEX,
  type SearchHit,
  type SearchIndex,
} from "../../src/modules/search/search-index";

/**
 * OpenSearch-backed document search, post-filtered by folder access (P3.6b).
 * The SEARCH_INDEX seam is faked: `search()` returns canned hits (so hydration,
 * relevance-order preservation, and the folder-access post-filter are testable
 * deterministically) and `active` is toggleable to exercise the Postgres
 * fallback. Restricted-subtree filtering + cross-tenant RLS drop are asserted.
 */
describe("Documents search (/v1/documents/search, P3.6b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let access: FolderAccessService;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let tenantId: string;
  let adminId: string;
  let adminToken: string; // tenant_admin → folder:manage bypass
  let opId: string;
  let opToken: string; // operator → document:read + folder:read, no manage
  let otherTenantId: string;
  let otherAdminId: string;
  const bucket = "cmc-files";

  let indexActive = true;
  let cannedHits: SearchHit[] = [];
  const fakeIndex: SearchIndex = {
    get active() {
      return indexActive;
    },
    async ensureIndex() {},
    async indexDocument() {},
    async deleteDocument() {},
    async search() {
      return cannedHits;
    },
    async ping() {
      return true;
    },
    async close() {},
  };

  async function seedDoc(
    name: string,
    opts: { tenant?: string; uploadedBy?: string; folderId?: string | null } = {},
  ): Promise<string> {
    const t = opts.tenant ?? tenantId;
    const by = opts.uploadedBy ?? adminId;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by, folder_id)
      VALUES (${t}, ${name}, 'text/plain', ${bucket},
        ${"tenants/" + t + "/documents/" + name}, 'ready', ${by}, ${opts.folderId ?? null})
      RETURNING id`;
    return rows[0]!.id;
  }

  const mkFolder = async (name: string): Promise<string> => {
    const res = await authed(app, adminToken)
      .post("/v1/folders")
      .send({ name })
      .expect(201);
    return res.body.folder.id as string;
  };
  const restrict = (id: string) =>
    authed(app, adminToken)
      .patch(`/v1/folders/${id}/restrict`)
      .send({ restricted: true })
      .expect(200);

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(SEARCH_INDEX).useValue(fakeIndex),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    access = app.get(FolderAccessService);
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql);
    tenant = created.tenant;
    tenantId = tenant.id;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;

    const op = await createUser(sql, tenant);
    opId = op.id;
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;

    const other = await createTenantWithAdmin(sql);
    otherTenantId = other.tenant.id;
    otherAdminId = other.user.id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    indexActive = true;
    cannedHits = [];
    await sql.unsafe(
      `TRUNCATE folder_grants, documents, folders RESTART IDENTITY CASCADE`,
    );
    await access.invalidateTenant(tenantId);
  });

  const hit = (id: string, score: number, folderId: string | null = null): SearchHit => ({
    id,
    score,
    folderId,
  });

  it("hydrates hits and preserves OpenSearch relevance order", async () => {
    const a = await seedDoc("alpha");
    const b = await seedDoc("bravo");
    const c = await seedDoc("charlie");
    cannedHits = [hit(b, 3), hit(c, 2), hit(a, 1)]; // OpenSearch's ranked order

    const res = await authed(app, adminToken)
      .get("/v1/documents/search?q=anything")
      .expect(200);
    expect(res.body.backend).toBe("opensearch");
    expect(res.body.documents.map((d: { id: string }) => d.id)).toEqual([b, c, a]);
  });

  it("post-filters out documents in a restricted folder the caller can't read", async () => {
    const secretFolder = await mkFolder("Secret");
    await restrict(secretFolder);
    const secret = await seedDoc("secret-plan", { folderId: secretFolder });
    const open = await seedDoc("open-plan");
    cannedHits = [hit(secret, 2, secretFolder), hit(open, 1)];

    // Operator (no grant) sees only the unfiled doc; admin sees both.
    const asOp = await authed(app, opToken)
      .get("/v1/documents/search?q=plan")
      .expect(200);
    expect(asOp.body.documents.map((d: { id: string }) => d.id)).toEqual([open]);

    const asAdmin = await authed(app, adminToken)
      .get("/v1/documents/search?q=plan")
      .expect(200);
    expect(asAdmin.body.documents.map((d: { id: string }) => d.id).sort()).toEqual(
      [secret, open].sort(),
    );
  });

  it("a folder grant unlocks the restricted doc for the grantee", async () => {
    const secretFolder = await mkFolder("Secret");
    await restrict(secretFolder);
    const secret = await seedDoc("secret-plan", { folderId: secretFolder });
    cannedHits = [hit(secret, 1, secretFolder)];

    expect(
      (await authed(app, opToken).get("/v1/documents/search?q=plan").expect(200))
        .body.documents,
    ).toHaveLength(0);

    await authed(app, adminToken)
      .post(`/v1/folders/${secretFolder}/grants`)
      .send({ subjectType: "user", subjectId: opId, access: "read" })
      .expect(201);
    await access.invalidateTenant(tenantId);

    const after = await authed(app, opToken)
      .get("/v1/documents/search?q=plan")
      .expect(200);
    expect(after.body.documents.map((d: { id: string }) => d.id)).toEqual([secret]);
  });

  it("drops cross-tenant ids during the RLS-scoped hydration", async () => {
    const mine = await seedDoc("mine");
    const theirs = await seedDoc("theirs", {
      tenant: otherTenantId,
      uploadedBy: otherAdminId,
    });
    cannedHits = [hit(theirs, 2), hit(mine, 1)]; // a stray cross-tenant hit leaks in

    const res = await authed(app, adminToken)
      .get("/v1/documents/search?q=x")
      .expect(200);
    expect(res.body.documents.map((d: { id: string }) => d.id)).toEqual([mine]);
  });

  it("falls back to Postgres (ILIKE) when the index is disabled", async () => {
    indexActive = false;
    await seedDoc("Quarterly Crisis Report");
    await seedDoc("Unrelated memo");
    // cannedHits intentionally left empty — the fallback must not consult them.
    cannedHits = [];

    const res = await authed(app, adminToken)
      .get("/v1/documents/search?q=quarterly")
      .expect(200);
    expect(res.body.backend).toBe("postgres");
    const names = res.body.documents.map((d: { name: string }) => d.name);
    expect(names).toContain("Quarterly Crisis Report");
    expect(names).not.toContain("Unrelated memo");
  });

  it("requires a non-empty q (400)", async () => {
    await authed(app, adminToken).get("/v1/documents/search").expect(400);
    await authed(app, adminToken)
      .get("/v1/documents/search?q=%20%20")
      .expect(400);
  });

  it("requires document:read", async () => {
    const viewer = await createUser(sql, tenant); // role-less → no document:read
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    await authed(app, viewerToken)
      .get("/v1/documents/search?q=x")
      .expect(403);
  });
});
