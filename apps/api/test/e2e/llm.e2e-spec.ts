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
  createLlmProvider,
  NoopLlmProvider,
} from "../../src/modules/llm/llm.provider";

const PROMPT = "SENSITIVE_PROMPT_DO_NOT_LOG_42";

/**
 * LLM gateway (P5.1 / ADR-0067). The provider is faked (no GPU / no network);
 * covers the gating factory, a completion round-trip, **metadata-only audit**
 * (the raw prompt must NOT land in audit_log), RBAC, and the per-tenant rate
 * limit. Real vLLM is a manual live-smoke.
 */
describe("LLM gateway (P5.1)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let adminId: string;
  let viewerToken: string;
  let rlToken: string;
  let rlTenantId: string;

  const fakeProvider: LlmProvider = {
    active: true,
    chat: async (req) => ({
      content: "FAKE_COMPLETION",
      model: req.model,
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      finishReason: "stop",
    }),
    embed: async (texts, model) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3]),
      model,
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(LLM_PROVIDER).useValue(fakeProvider),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const { user: admin } = await createTenantWithAdmin(sql); // llm:use via *
    adminId = admin.id;
    adminToken = (await loginAs(app, admin)).accessToken;

    const viewer = await createUser(sql, { id: admin.tenantId, slug: "x", name: "x" });
    viewerToken = (await loginAs(app, viewer)).accessToken;

    const rl = await createTenantWithAdmin(sql);
    rlTenantId = rl.tenant.id;
    rlToken = (await loginAs(app, rl.user)).accessToken;
  });

  afterAll(async () => {
    const keys = await redis.keys("cmc:llm:rl:*");
    if (keys.length) await redis.del(...keys);
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("createLlmProvider returns a noop when LLM_ENABLED is false", async () => {
    const provider = createLlmProvider({
      get: (k: string) => (k === "LLM_ENABLED" ? false : undefined),
    } as unknown as Parameters<typeof createLlmProvider>[0]);
    expect(provider).toBeInstanceOf(NoopLlmProvider);
    expect(provider.active).toBe(false);
    await expect(
      provider.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/disabled/);
  });

  it("completes a chat + audits metadata ONLY (no raw prompt)", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/llm/complete")
      .send({ messages: [{ role: "user", content: PROMPT }] })
      .expect(200);
    expect(res.body.content).toBe("FAKE_COMPLETION");
    expect(res.body.usage.totalTokens).toBe(18);
    expect(res.body.finishReason).toBe("stop");

    const rows = await sql<{ meta: string; outcome: string }[]>`
      SELECT metadata::text AS meta, outcome FROM audit_log
      WHERE action = 'llm.complete' AND actor_id = ${adminId}
      ORDER BY occurred_at DESC LIMIT 1`;
    expect(rows[0]!.outcome).toBe("success");
    expect(rows[0]!.meta).toContain("totalTokens");
    expect(rows[0]!.meta).toContain("model");
    // The sovereignty guarantee: the raw prompt is NOT in the audit row.
    expect(rows[0]!.meta).not.toContain(PROMPT);
  });

  it("rejects a user without llm:use (403)", async () => {
    await authed(app, viewerToken)
      .post("/v1/llm/complete")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(403);
  });

  it("rejects an invalid request (empty messages → 400)", async () => {
    await authed(app, adminToken)
      .post("/v1/llm/complete")
      .send({ messages: [] })
      .expect(400);
  });

  it("enforces the per-tenant rate limit (429)", async () => {
    // Pre-seed the tenant's minute counter past any configured limit.
    await redis.set(`cmc:llm:rl:${rlTenantId}`, "999999", "EX", 60);
    await authed(app, rlToken)
      .post("/v1/llm/complete")
      .send({ messages: [{ role: "user", content: "hi" }] })
      .expect(429);
  });
});
