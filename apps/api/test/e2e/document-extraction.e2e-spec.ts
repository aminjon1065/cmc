import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";
import {
  TEXT_EXTRACTOR,
  type TextExtractor,
} from "../../src/modules/documents/text-extractor";

const TEXT = "Flood evacuation plan: move residents to designated shelters.";

/**
 * Document text extraction (P5.6a / ADR-0072). The extractor is faked (returns
 * the document's UTF-8 bytes — no real OCR toolchain) and active. Covers the
 * extract→`document_text` upsert (chars + status), idempotency, the empty case,
 * the read endpoint (incl. not-yet-extracted), RBAC, and 404. Bytes are seeded
 * into real S3 (MinIO). Real OCR (Tesseract) is a sovereign/on-prem live smoke.
 */
describe("Document extraction (/v1/documents/:id, P5.6a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let storage: StorageService;
  let bucket: string;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let tenantId: string;
  let adminId: string;
  let adminToken: string;
  let docId: string;
  let emptyDocId: string;
  let freshDocId: string;
  let seq = 0;

  const fakeExtractor: TextExtractor = {
    active: true,
    extract: async (bytes) => bytes.toString("utf8"),
  };

  async function seedDoc(name: string, body: string): Promise<string> {
    const key = `docs/${name}-${seq++}.txt`;
    await storage.putObject({
      bucket,
      key,
      body: Buffer.from(body),
      contentType: "text/plain",
    });
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, uploaded_by, status)
      VALUES (${tenantId}, ${name}, 'text/plain', ${bucket}, ${key}, ${adminId}, 'ready')
      RETURNING id`;
    return rows[0]!.id;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(TEXT_EXTRACTOR).useValue(fakeExtractor),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    storage = app.get(StorageService);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES") as string;
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql); // admin → document:*
    tenant = created.tenant;
    tenantId = tenant.id;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;

    docId = await seedDoc("flood-plan", TEXT);
    emptyDocId = await seedDoc("blank", "");
    freshDocId = await seedDoc("not-extracted", "irrelevant");
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("extracts a document's text into document_text", async () => {
    const res = await authed(app, adminToken)
      .post(`/v1/documents/${docId}/extract`)
      .expect(200);
    expect(res.body).toMatchObject({
      documentId: docId,
      status: "done",
      charCount: TEXT.length,
    });

    const got = await authed(app, adminToken)
      .get(`/v1/documents/${docId}/text`)
      .expect(200);
    expect(got.body).toMatchObject({
      documentId: docId,
      extracted: true,
      status: "done",
      charCount: TEXT.length,
      content: TEXT,
    });
    expect(got.body.extractedAt).toEqual(expect.any(String));
  });

  it("is idempotent — re-extract upserts (one row per document)", async () => {
    await authed(app, adminToken)
      .post(`/v1/documents/${docId}/extract`)
      .expect(200);
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM document_text WHERE document_id = ${docId}`;
    expect(rows[0]!.c).toBe(1);
  });

  it("reports status 'empty' when no text is found", async () => {
    const res = await authed(app, adminToken)
      .post(`/v1/documents/${emptyDocId}/extract`)
      .expect(200);
    expect(res.body).toMatchObject({ status: "empty", charCount: 0 });
    const got = await authed(app, adminToken)
      .get(`/v1/documents/${emptyDocId}/text`)
      .expect(200);
    expect(got.body).toMatchObject({
      extracted: true,
      status: "empty",
      charCount: 0,
      content: "",
    });
  });

  it("GET text for a not-yet-extracted document → extracted:false", async () => {
    const got = await authed(app, adminToken)
      .get(`/v1/documents/${freshDocId}/text`)
      .expect(200);
    expect(got.body).toMatchObject({
      documentId: freshDocId,
      extracted: false,
      status: null,
      charCount: 0,
      content: null,
      extractedAt: null,
    });
  });

  it("404 when extracting an unknown / not-ready document", async () => {
    await authed(app, adminToken)
      .post(`/v1/documents/00000000-0000-0000-0000-000000000000/extract`)
      .expect(404);
  });

  it("RBAC: a role-less viewer cannot extract (403) or read text (403)", async () => {
    const viewer = await createUser(sql, tenant);
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    await authed(app, viewerToken)
      .post(`/v1/documents/${docId}/extract`)
      .expect(403);
    await authed(app, viewerToken)
      .get(`/v1/documents/${docId}/text`)
      .expect(403);
  });
});

/** When extraction is disabled the extractor is inactive → extract 503s. */
describe("Document extraction when disabled (P5.6a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let docId: string;

  const inactiveExtractor: TextExtractor = {
    active: false,
    extract: async () => "",
  };

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(TEXT_EXTRACTOR).useValue(inactiveExtractor),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, user)).accessToken;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, uploaded_by, status)
      VALUES (${tenant.id}, 'x', 'text/plain', 'cmc-files', 'docs/x.txt', ${user.id}, 'ready')
      RETURNING id`;
    docId = rows[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("returns 503", async () => {
    await authed(app, adminToken)
      .post(`/v1/documents/${docId}/extract`)
      .expect(503);
  });
});
