import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  DocumentResponseSchema,
  DownloadUrlResponseSchema,
  FinalizeUploadResponseSchema,
  ListDocumentsResponseSchema,
  UploadInitResponseSchema,
} from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { authed, loginAs } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

describe("Documents", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let user: TestUser;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "docs-test",
      email: "doc-owner@docs.test",
      password: "doc_owner_pwd_12",
    });
    user = fixture.user;
    accessToken = (await loginAs(app, user)).accessToken;
  });

  // ---------- list ----------

  it("GET /documents returns an empty list initially", async () => {
    const res = await authed(app, accessToken).get("/v1/documents").expect(200);
    const list = ListDocumentsResponseSchema.parse(res.body);
    expect(list.total).toBe(0);
    expect(list.documents).toEqual([]);
  });

  // ---------- upload-init ----------

  it("POST /documents/upload-init creates a pending row + returns presigned URL", async () => {
    const res = await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        description: "Q3 report",
      })
      .expect(201);

    const parsed = UploadInitResponseSchema.parse(res.body);
    expect(parsed.document.status).toBe("uploading");
    expect(parsed.document.name).toBe("report.pdf");
    expect(parsed.upload.method).toBe("PUT");
    expect(parsed.upload.url).toMatch(/^https?:\/\/.*X-Amz-Signature=/);
    expect(parsed.upload.headers["Content-Type"]).toBe("application/pdf");
  });

  it("rejects oversize uploads with 400", async () => {
    await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "huge.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1024 * 1024 * 1024, // 1 GiB > 100 MiB limit
      })
      .expect(400);
  });

  it("rejects payloads with invalid MIME type via DTO validation", async () => {
    await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "x.bin",
        mimeType: "not a mime",
        sizeBytes: 10,
      })
      .expect(400);
  });

  // ---------- finalize ----------

  it("POST /documents/:id/finalize fails when the object is missing", async () => {
    const init = await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "missing.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      })
      .expect(201);
    const docId = UploadInitResponseSchema.parse(init.body).document.id;

    // We never PUT bytes to the bucket — finalize should refuse.
    await authed(app, accessToken)
      .post(`/v1/documents/${docId}/finalize`)
      .expect(400);

    // Status flipped to 'failed' with a structured reason.
    await sql`SET app.bypass_rls = 'on'`;
    const row = await sql<
      { status: string; metadata: { failureReason?: string } | null }[]
    >`
      SELECT status, metadata FROM documents WHERE id = ${docId}
    `;
    await sql`RESET app.bypass_rls`;
    expect(row[0]?.status).toBe("failed");
    expect(row[0]?.metadata?.failureReason).toBe("object_missing");
  });

  it("full lifecycle: init → PUT to MinIO → finalize → list → download URL → delete → list empty", async () => {
    // 1. init
    const init = await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "hello.txt",
        mimeType: "text/plain",
        sizeBytes: 13,
      })
      .expect(201);
    const initBody = UploadInitResponseSchema.parse(init.body);
    const docId = initBody.document.id;

    // 2. PUT to MinIO via the presigned URL.
    const putRes = await fetch(initBody.upload.url, {
      method: "PUT",
      headers: initBody.upload.headers,
      body: "Hello, world!",
    });
    expect(putRes.ok).toBe(true);

    // 3. finalize — server HEADs the object, captures size + ETag.
    const fin = await authed(app, accessToken)
      .post(`/v1/documents/${docId}/finalize`)
      .expect(200);
    const finBody = FinalizeUploadResponseSchema.parse(fin.body);
    expect(finBody.document.status).toBe("ready");
    expect(finBody.document.sizeBytes).toBe(13);

    // 4. list — the doc is there.
    const list = await authed(app, accessToken).get("/v1/documents").expect(200);
    const listBody = ListDocumentsResponseSchema.parse(list.body);
    expect(listBody.total).toBe(1);
    expect(listBody.documents[0]?.id).toBe(docId);

    // 5. download URL — fetch via the presigned GET, bytes match.
    const dl = await authed(app, accessToken)
      .get(`/v1/documents/${docId}/download-url`)
      .expect(200);
    const dlBody = DownloadUrlResponseSchema.parse(dl.body);
    const fetched = await fetch(dlBody.url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("Hello, world!");

    // 6. delete (soft).
    await authed(app, accessToken).delete(`/v1/documents/${docId}`).expect(204);

    // 7. list is empty again.
    const after = await authed(app, accessToken).get("/v1/documents").expect(200);
    expect(ListDocumentsResponseSchema.parse(after.body).total).toBe(0);

    // DB row is soft-deleted, not hard-deleted.
    await sql`SET app.bypass_rls = 'on'`;
    const dbRow = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM documents WHERE id = ${docId}
    `;
    await sql`RESET app.bypass_rls`;
    expect(dbRow[0]?.deleted_at).not.toBeNull();
  });

  // ---------- get / not found ----------

  it("GET /documents/:id returns 404 for a non-existent id", async () => {
    await authed(app, accessToken)
      .get("/v1/documents/00000000-0000-0000-0000-000000000000")
      .expect(404);
  });

  it("GET /documents/:id returns the metadata for an owned ready doc", async () => {
    // Pre-seed a ready doc directly via SQL — saves a full upload round-trip.
    await sql`SET app.bypass_rls = 'on'`;
    const tenantId = (
      await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM users WHERE id = ${user.id}
    `
    )[0]!.tenant_id;
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO documents (
        tenant_id, name, mime_type, size_bytes, storage_bucket,
        storage_key, status, uploaded_by, etag
      ) VALUES (
        ${tenantId}, 'pre.txt', 'text/plain', 5, 'cmc-files',
        ${`tenants/${tenantId}/documents/pre`}, 'ready', ${user.id}, 'abc'
      ) RETURNING id
    `;
    await sql`RESET app.bypass_rls`;

    const res = await authed(app, accessToken)
      .get(`/v1/documents/${inserted[0]!.id}`)
      .expect(200);
    const body = DocumentResponseSchema.parse(res.body);
    expect(body.document.name).toBe("pre.txt");
    expect(body.document.status).toBe("ready");
  });

  // ---------- audit ----------

  it("audit_log captures upload_init, finalize, and delete", async () => {
    const init = await authed(app, accessToken)
      .post("/v1/documents/upload-init")
      .send({
        name: "audited.txt",
        mimeType: "text/plain",
        sizeBytes: 13,
      })
      .expect(201);
    const docId = UploadInitResponseSchema.parse(init.body).document.id;

    await fetch(UploadInitResponseSchema.parse(init.body).upload.url, {
      method: "PUT",
      headers: UploadInitResponseSchema.parse(init.body).upload.headers,
      body: "Hello, world!",
    });

    await authed(app, accessToken)
      .post(`/v1/documents/${docId}/finalize`)
      .expect(200);

    await authed(app, accessToken).delete(`/v1/documents/${docId}`).expect(204);

    await sql`SET app.bypass_rls = 'on'`;
    const actions = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE resource_type = 'document' AND resource_id = ${docId}
      ORDER BY occurred_at
    `;
    await sql`RESET app.bypass_rls`;
    expect(actions.map((a) => a.action)).toEqual([
      "document.upload_init",
      "document.finalize",
      "document.delete",
    ]);
  });
});
