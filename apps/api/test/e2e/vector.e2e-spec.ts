import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  LLM_PROVIDER,
  type LlmProvider,
} from "../../src/modules/llm/llm.provider";

/**
 * Vector pipeline (P5.2 / ADR-0068). The LLM provider is faked (active, returns
 * a fixed embedding). Covers the reindex backfill (embed + upsert into
 * `document_embeddings`), idempotency, status, and RBAC. The finalize hook calls
 * the same `indexDocument` path; real embeddings are a manual live-smoke.
 */
describe("Vector pipeline (P5.2)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let bucket: string;
  let tenantId: string;
  let adminId: string;
  let adminToken: string;
  let viewerToken: string;

  const VEC = [0.1, 0.2, 0.3, 0.4];
  const fakeProvider: LlmProvider = {
    active: true,
    chat: async (req) => ({
      content: "x",
      model: req.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    }),
    embed: async (texts, model) => ({
      embeddings: texts.map(() => [...VEC]),
      model,
      usage: { promptTokens: 5, totalTokens: 5 },
    }),
  };

  async function seedDocument(name: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO documents (tenant_id, name, mime_type, storage_bucket, storage_key, uploaded_by, status)
      VALUES (${tenantId}, ${name}, 'text/plain', ${bucket}, ${"docs/" + name}, ${adminId}, 'ready')
      RETURNING id`;
    return row!.id;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(LLM_PROVIDER).useValue(fakeProvider),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES") as string;
    await truncateAll(sql, redis);

    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = admin.id;
    adminToken = (await loginAs(app, admin)).accessToken;

    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;

    await seedDocument("Flood response plan");
    await seedDocument("Earthquake drill notes");
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("reindex embeds all available documents into document_embeddings", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/vector/reindex")
      .expect(200);
    expect(res.body.indexed).toBe(2);

    const rows = await sql<{ dims: number; model: string; emb: string }[]>`
      SELECT dims, model, embedding::text AS emb FROM document_embeddings
      WHERE tenant_id = ${tenantId} ORDER BY created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dims).toBe(4);
    expect(rows[0]!.model).toBe("bge-m3"); // the gateway's default embed model
    expect(JSON.parse(rows[0]!.emb)).toEqual(VEC);
  });

  it("reindex is idempotent (upsert per document, not duplicate rows)", async () => {
    await authed(app, adminToken).post("/v1/vector/reindex").expect(200);
    const rows = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM document_embeddings WHERE tenant_id = ${tenantId}`;
    expect(rows[0]!.c).toBe(2);
  });

  it("status reports active + the indexed count", async () => {
    const res = await authed(app, adminToken)
      .get("/v1/vector/status")
      .expect(200);
    expect(res.body.active).toBe(true);
    expect(res.body.indexed).toBe(2);
  });

  it("RBAC: a role-less viewer cannot read status (403) or reindex (403)", async () => {
    await authed(app, viewerToken).get("/v1/vector/status").expect(403);
    await authed(app, viewerToken).post("/v1/vector/reindex").expect(403);
  });
});
