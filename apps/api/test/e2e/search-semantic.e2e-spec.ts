import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  LLM_PROVIDER,
  type LlmProvider,
} from "../../src/modules/llm/llm.provider";
import { cosineSimilarity } from "../../src/modules/vector/cosine";

/**
 * Semantic search (P5.3 / ADR-0069). The vector kNN lane is fused into the
 * federated `/v1/search` (P3.7) by RRF. The LLM provider is faked: its `embed`
 * returns a deterministic, query-steered vector so we can drive the nearest
 * neighbour. OpenSearch is left off (the default Noop seam), so the keyword lane
 * is Postgres FTS — proving the keyword + vector hybrid without any external
 * service. Embeddings are seeded directly so each document's vector is known.
 *
 * Coverage: a semantically-related document the keyword lane misses surfaces via
 * the vector lane; a document matched by BOTH lanes is deduped into one `hybrid`
 * hit; the vector lane is folder-access + lifecycle filtered (a soft-deleted doc
 * is dropped even though it's the nearest neighbour); and a caller without
 * `document:read` gets nothing (permission-aware retrieval). Real embeddings are
 * a manual live-smoke.
 */
describe("Semantic search (/v1/search, P5.3)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let tenantId: string;
  let adminId: string;
  let adminToken: string;
  let docQuake: string; // "Earthquake response plan" — vector-only ([1,0,0,0])
  let docBudget: string; // "Quarterly budget ledger" — keyword + vector ([0,1,0,0])
  let docMemo: string; // "Logistics status memo" — vector-only default ([0,0,1,0])

  /** Steer the fake embedding by the query/text so kNN is deterministic. */
  function embedFor(text: string): number[] {
    const t = text.toLowerCase();
    if (t.includes("seismic")) return [1, 0, 0, 0];
    if (t.includes("budget")) return [0, 1, 0, 0];
    return [0, 0, 1, 0];
  }
  const fakeProvider: LlmProvider = {
    active: true,
    chat: async (req) => ({
      content: "x",
      model: req.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    }),
    embed: async (texts, model) => ({
      embeddings: texts.map((t) => embedFor(t)),
      model,
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };

  async function seedDoc(name: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, ${name}, 'text/plain', 'cmc-files',
        ${"docs/" + name}, 'ready', ${adminId})
      RETURNING id`;
    return rows[0]!.id;
  }
  async function seedEmbedding(docId: string, vec: number[]): Promise<void> {
    await sql`
      INSERT INTO document_embeddings (tenant_id, document_id, model, dims, embedding)
      VALUES (${tenantId}, ${docId}, 'bge-m3', ${vec.length}, ${JSON.stringify(vec)}::jsonb)`;
  }
  const docIds = (body: { results: { type: string; id: string }[] }): string[] =>
    body.results.filter((r) => r.type === "document").map((r) => r.id);

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(LLM_PROVIDER).useValue(fakeProvider),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql); // admin → `*` (document:read)
    tenant = created.tenant;
    tenantId = tenant.id;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;

    docQuake = await seedDoc("Earthquake response plan");
    docBudget = await seedDoc("Quarterly budget ledger");
    docMemo = await seedDoc("Logistics status memo");
    await seedEmbedding(docQuake, [1, 0, 0, 0]);
    await seedEmbedding(docBudget, [0, 1, 0, 0]);
    await seedEmbedding(docMemo, [0, 0, 1, 0]);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  describe("cosineSimilarity (pure)", () => {
    it("scores identical vectors as 1 and orthogonal vectors as 0", () => {
      expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 10);
      expect(cosineSimilarity([1, 0, 0], [0, 5, 0])).toBe(0);
    });
    it("returns 0 for mismatched dimensions or a zero-magnitude vector", () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
    });
    it("scores opposite vectors negatively", () => {
      expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
    });
  });

  describe("hybrid retrieval over /v1/search", () => {
    it("surfaces a semantically-related document the keyword lane misses (source 'vector')", async () => {
      // "seismic" shares no token with "Earthquake response plan" → FTS misses
      // it; the query embeds nearest to docQuake → the vector lane finds it.
      const res = await authed(app, adminToken)
        .get("/v1/search?q=seismic%20swarm")
        .expect(200);
      const ids = docIds(res.body);
      expect(ids).toContain(docQuake);
      expect(ids).not.toContain(docBudget);
      expect(ids).not.toContain(docMemo);
      const hit = res.body.results.find(
        (r: { id: string }) => r.id === docQuake,
      );
      expect(hit.type).toBe("document");
      expect(hit.source).toBe("vector");
      expect(hit.score).toBeGreaterThan(0);
    });

    it("dedupes a document matched by both keyword and vector into one 'hybrid' hit", async () => {
      // "budget" matches docBudget's name (FTS) AND embeds nearest to it (vector).
      const res = await authed(app, adminToken)
        .get("/v1/search?q=budget")
        .expect(200);
      const budgetHits = res.body.results.filter(
        (r: { id: string }) => r.id === docBudget,
      );
      expect(budgetHits).toHaveLength(1); // deduped, not two rows
      expect(budgetHits[0].source).toBe("hybrid");
      // A hybrid hit (two RRF terms) outscores a single-lane hit at the same rank.
      expect(budgetHits[0].score).toBeGreaterThan(1 / (60 + 1));
    });

    it("applies lifecycle/access filtering to the vector lane (soft-deleted doc excluded)", async () => {
      // Pre-delete: the default-cluster query embeds nearest to docMemo.
      const before = await authed(app, adminToken)
        .get("/v1/search?q=miscellaneous%20notes")
        .expect(200);
      expect(docIds(before.body)).toContain(docMemo);
      const memoHit = before.body.results.find(
        (r: { id: string }) => r.id === docMemo,
      );
      expect(memoHit.source).toBe("vector");

      // Soft-delete the document (the embedding row remains). The vector lane
      // still returns its id, but hydration drops it (deleted_at filter).
      await sql`UPDATE documents SET deleted_at = now() WHERE id = ${docMemo}`;
      const after = await authed(app, adminToken)
        .get("/v1/search?q=miscellaneous%20notes")
        .expect(200);
      expect(docIds(after.body)).not.toContain(docMemo);
    });

    it("does not surface vector hits to a caller without document:read", async () => {
      const viewer = await createUser(sql, tenant); // role-less
      const viewerToken = (await loginAs(app, viewer)).accessToken;
      const res = await authed(app, viewerToken)
        .get("/v1/search?q=seismic%20swarm")
        .expect(200);
      expect(res.body.results).toHaveLength(0);
    });
  });
});
