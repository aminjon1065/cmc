import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";
import {
  TEXT_EXTRACTOR,
  type TextExtractor,
} from "../../src/modules/documents/text-extractor";
import {
  EXTRACT_QUEUE,
  type ExtractQueue,
} from "../../src/modules/documents/extract.queue";
import {
  SEARCH_INDEX,
  type SearchIndex,
  type IndexedDocument,
} from "../../src/modules/search/search-index";
import {
  LLM_PROVIDER,
  type LlmProvider,
} from "../../src/modules/llm/llm.provider";

const TEXT = "Flood evacuation protocol — move residents to designated shelters.";

/**
 * Document extraction pipeline (P5.6b / ADR-0072). Fakes: TEXT_EXTRACTOR (returns
 * UTF-8 bytes), LLM_PROVIDER (active embed → vector re-embed runs), SEARCH_INDEX
 * (active, captures index calls), EXTRACT_QUEUE (captures enqueues). Covers the
 * auto-enqueue on finalize and the best-effort re-index after extraction (the
 * extracted content reaches OpenSearch + a `document_embeddings` row). The real
 * BullMQ worker + Tesseract are a live boundary.
 */
describe("Document extraction pipeline (P5.6b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let storage: StorageService;
  let bucket: string;
  let tenantId: string;
  let adminId: string;
  let adminToken: string;
  let seq = 0;

  const indexed: { id: string; content: string | null }[] = [];
  const enqueued: string[] = [];

  const fakeExtractor: TextExtractor = {
    active: true,
    extract: async (bytes) => bytes.toString("utf8"),
  };
  const fakeQueue: ExtractQueue = {
    active: true,
    enqueue: async (job) => {
      enqueued.push(job.documentId);
    },
    close: async () => {},
  };
  const fakeSearchIndex: SearchIndex = {
    active: true,
    ensureIndex: async () => {},
    indexDocument: async (doc: IndexedDocument) => {
      indexed.push({ id: doc.id, content: doc.content ?? null });
    },
    deleteDocument: async () => {},
    search: async () => [],
    ping: async () => true,
    close: async () => {},
  };
  const fakeLlm: LlmProvider = {
    active: true,
    chat: async (req) => ({
      content: "x",
      model: req.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    }),
    embed: async (texts, model) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      model,
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };

  async function seedReadyDoc(name: string, body: string): Promise<string> {
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
      b
        .overrideProvider(TEXT_EXTRACTOR)
        .useValue(fakeExtractor)
        .overrideProvider(EXTRACT_QUEUE)
        .useValue(fakeQueue)
        .overrideProvider(SEARCH_INDEX)
        .useValue(fakeSearchIndex)
        .overrideProvider(LLM_PROVIDER)
        .useValue(fakeLlm),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    storage = app.get(StorageService);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES") as string;
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql);
    tenantId = created.tenant.id;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("re-indexes extracted content into OpenSearch + re-embeds (vector) on extract", async () => {
    const id = await seedReadyDoc("flood", TEXT);
    indexed.length = 0;

    await authed(app, adminToken)
      .post(`/v1/documents/${id}/extract`)
      .expect(200);

    // OpenSearch re-index got the extracted content.
    const hit = indexed.find((d) => d.id === id);
    expect(hit).toBeDefined();
    expect(hit!.content).toBe(TEXT);

    // Vector re-embed wrote a document_embeddings row (content-aware).
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM document_embeddings WHERE document_id = ${id}`;
    expect(rows[0]!.c).toBe(1);
  });

  it("auto-enqueues an extraction job on document finalize", async () => {
    enqueued.length = 0;
    const body = Buffer.from(TEXT);

    const init = await authed(app, adminToken)
      .post("/v1/documents/upload-init")
      .send({ name: "report.txt", mimeType: "text/plain", sizeBytes: body.length })
      .expect(201);
    const id = init.body.document.id as string;

    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "text/plain" },
    });
    expect(put.ok).toBe(true);

    await authed(app, adminToken)
      .post(`/v1/documents/${id}/finalize`)
      .expect(200);

    expect(enqueued).toContain(id); // finalize enqueued the extract job
  });
});
