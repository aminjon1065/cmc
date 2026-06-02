import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  SEARCH_INDEX,
  type IndexedDocument,
  type SearchHit,
  type SearchIndex,
} from "../../src/modules/search/search-index";

/**
 * Best-effort OpenSearch indexing (P3.6a). The SEARCH_INDEX seam is faked
 * (capturing, active), so the real OpenSearch driver never enters jest while
 * DocumentsService's index/unindex/reindex calls remain observable. The faked
 * index throwing must NOT break the document write path.
 */
describe("Documents search indexing (P3.6a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  let adminId: string;
  const bucket = "cmc-files";

  const indexed: IndexedDocument[] = [];
  const deleted: Array<{ tenantId: string; id: string }> = [];
  let throwOnIndex = false;

  const fakeIndex: SearchIndex = {
    active: true,
    async ensureIndex() {},
    async indexDocument(doc: IndexedDocument) {
      if (throwOnIndex) throw new Error("opensearch down");
      indexed.push(doc);
    },
    async deleteDocument(t: string, id: string) {
      deleted.push({ tenantId: t, id });
    },
    async search(): Promise<SearchHit[]> {
      return [];
    },
    async ping() {
      return true;
    },
    async close() {},
  };

  // Seed a ready document straight in the DB (no MinIO object needed).
  async function seedReady(name: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, ${name}, 'text/plain', ${bucket},
        ${"tenants/" + tenantId + "/documents/" + name}, 'ready', ${adminId})
      RETURNING id`;
    return rows[0]!.id;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(SEARCH_INDEX).useValue(fakeIndex),
    );
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
    indexed.length = 0;
    deleted.length = 0;
    throwOnIndex = false;
    await sql.unsafe(`TRUNCATE documents RESTART IDENTITY CASCADE`);
  });

  it("indexes a document on finalize", async () => {
    const body = Buffer.from("hello search world");
    const init = await authed(app, token)
      .post("/v1/documents/upload-init")
      .send({ name: "note.txt", mimeType: "text/plain", sizeBytes: body.length });
    expect(init.status).toBe(201);
    const id = init.body.document.id as string;

    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "text/plain" },
    });
    expect(put.ok).toBe(true);

    await authed(app, token).post(`/v1/documents/${id}/finalize`).expect(200);

    const hit = indexed.find((d) => d.id === id);
    expect(hit).toBeDefined();
    expect(hit!.tenantId).toBe(tenantId);
    expect(hit!.name).toBe("note.txt");
    expect(hit!.status).toBe("ready");
    expect(typeof hit!.createdAt).toBe("string");
  }, 30_000);

  it("unindexes a document on delete", async () => {
    const id = await seedReady("gone.txt");
    await authed(app, token).delete(`/v1/documents/${id}`).expect(204);
    expect(deleted).toContainEqual({ tenantId, id });
  });

  it("re-indexes on move", async () => {
    const id = await seedReady("movable.txt");
    indexed.length = 0;
    const folder = await authed(app, token)
      .post("/v1/folders")
      .send({ name: "Filed" })
      .expect(201);
    const folderId = folder.body.folder.id as string;

    await authed(app, token)
      .post(`/v1/documents/${id}/move`)
      .send({ folderId })
      .expect(200);

    const hit = indexed.find((d) => d.id === id);
    expect(hit).toBeDefined();
    expect(hit!.folderId).toBe(folderId);
  });

  it("reindex pushes every ready document and reports the count", async () => {
    const a = await seedReady("a.txt");
    const b = await seedReady("b.txt");
    // A non-ready doc is skipped by reindex.
    await sql`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, 'pending.txt', 'text/plain', ${bucket},
        ${"tenants/" + tenantId + "/documents/pending"}, 'uploading', ${adminId})`;

    const res = await authed(app, token)
      .post("/v1/documents/reindex")
      .expect(200);
    expect(res.body.indexed).toBe(2);
    const ids = indexed.map((d) => d.id).sort();
    expect(ids).toEqual([a, b].sort());
  });

  it("indexing failures do not break the write path (best-effort)", async () => {
    throwOnIndex = true;
    const body = Buffer.from("resilient");
    const init = await authed(app, token)
      .post("/v1/documents/upload-init")
      .send({ name: "ok.txt", mimeType: "text/plain", sizeBytes: body.length });
    const id = init.body.document.id as string;
    await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "text/plain" },
    });
    // Finalize still succeeds even though indexDocument throws.
    await authed(app, token).post(`/v1/documents/${id}/finalize`).expect(200);
    const got = await authed(app, token).get(`/v1/documents/${id}`).expect(200);
    expect(got.body.document.status).toBe("ready");
  }, 30_000);
});
