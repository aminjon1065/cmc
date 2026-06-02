import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { SEARCH_INDEX, type SearchIndex } from "../../src/modules/search/search-index";

/**
 * LIVE SMOKE (not part of the default suite — `.live-smoke.ts`, excluded by the
 * `.e2e-spec.ts` testRegex). Run with a real OpenSearch up:
 *
 *   cd apps/api && OPENSEARCH_ENABLED=true OPENSEARCH_URL=http://localhost:9200 \
 *     NODE_OPTIONS=--experimental-vm-modules npx jest --config test/jest-e2e.config.js \
 *     --testRegex 'search-federated\.live-smoke\.ts$'
 *
 * Exercises the FULL real path: a finalized upload is indexed into OpenSearch by
 * the P3.6a indexer, then `/v1/search` (P3.7) returns it (source=opensearch)
 * fused with a Postgres-FTS incident (source=postgres).
 */
describe("LIVE: federated search over real OpenSearch", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let index: SearchIndex;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    index = app.get<SearchIndex>(SEARCH_INDEX);
    await truncateAll(sql, redis);
    const { user } = await createTenantWithAdmin(sql);
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    // Leave a clean index for repeat runs.
    try {
      await fetch("http://localhost:9200/cmc-documents", { method: "DELETE" });
    } catch {
      /* ignore */
    }
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("indexes a finalized document and returns it from /v1/search merged with an incident", async () => {
    // Guard: this smoke is meaningful only against a real index.
    expect(index.active).toBe(true);

    await authed(app, token)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "flood",
        region: "Khatlon",
        summary: "Flood emergency response near the river",
        occurredAt: "2026-06-02T08:00:00.000Z",
      })
      .expect(201);

    const body = Buffer.from("annual flood report contents");
    const init = await authed(app, token)
      .post("/v1/documents/upload-init")
      .send({
        name: "flood-report.pdf",
        description: "Annual flood report",
        mimeType: "application/pdf",
        sizeBytes: body.length,
      })
      .expect(201);
    const docId = init.body.document.id as string;
    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "application/pdf" },
    });
    expect(put.ok).toBe(true);
    // finalize → P3.6a indexer pushes to OpenSearch (refresh:true).
    await authed(app, token).post(`/v1/documents/${docId}/finalize`).expect(200);

    const res = await authed(app, token).get("/v1/search?q=flood").expect(200);
    const results = res.body.results as Array<{
      type: string;
      id: string;
      source: string;
    }>;

    const doc = results.find((r) => r.type === "document");
    const incident = results.find((r) => r.type === "incident");
    expect(doc).toBeDefined();
    expect(doc!.id).toBe(docId);
    expect(doc!.source).toBe("opensearch"); // served by the real index
    expect(incident).toBeDefined();
    expect(incident!.source).toBe("postgres"); // FTS

    // Also exercise the dedicated document search endpoint (P3.6b) live.
    const ds = await authed(app, token)
      .get("/v1/documents/search?q=flood")
      .expect(200);
    expect(ds.body.backend).toBe("opensearch");
    expect(ds.body.documents.map((d: { id: string }) => d.id)).toContain(docId);

    console.log("LIVE federated search OK:", JSON.stringify(results, null, 2));
  }, 30_000);
});
