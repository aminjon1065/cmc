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

const SENTINEL = "RAGSENTINEL4242"; // appears in the question; must NOT be audited
const ANSWER = "Move residents to designated shelters [1].";
const NO_ANSWER = "I could not find an answer in the available sources.";

/**
 * RAG (P5.4 / ADR-0070). The LLM provider is faked: `chat` returns a fixed,
 * citation-bearing answer and counts its calls (so we can prove the no-source
 * path makes NO call). Retrieval is the real permission-aware hybrid
 * `/v1/search` (P5.3) over a seeded incident. Covers: grounded answer +
 * `[n]`→id citation resolution; honest no-answer with no LLM call; the
 * **metadata-only `rag.ask` audit** (provenance = cited ids; the raw question is
 * absent); and RBAC. Real generation is a manual live-smoke.
 */
describe("RAG (/v1/rag/ask, P5.4)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let adminId: string;
  let adminToken: string;
  let incidentId: string;

  let chatCalls = 0;
  const fakeProvider: LlmProvider = {
    active: true,
    chat: async (req) => {
      chatCalls++;
      return {
        content: ANSWER,
        model: req.model,
        usage: { promptTokens: 42, completionTokens: 9, totalTokens: 51 },
        finishReason: "stop",
      };
    },
    embed: async (texts, model) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]),
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

    const created = await createTenantWithAdmin(sql); // admin → `*` (llm:use, *:read)
    tenant = created.tenant;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;

    await authed(app, adminToken)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "flood",
        region: "Khatlon",
        summary: "Riverine flood evacuation protocol",
        description: `Move residents from the floodplain to designated shelters. Ref ${SENTINEL}.`,
        occurredAt: "2026-06-02T08:00:00.000Z",
      })
      .expect(201);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM incidents WHERE tenant_id = ${tenant.id} LIMIT 1`;
    incidentId = rows[0]!.id;
  });

  afterAll(async () => {
    const keys = await redis.keys("cmc:llm:rl:*");
    if (keys.length) await redis.del(...keys);
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("grounds the answer in retrieved sources and resolves [n] citations", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/rag/ask")
      .send({ question: "flood evacuation" })
      .expect(200);
    expect(res.body.answer).toBe(ANSWER);
    expect(res.body.grounded).toBe(true);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({
      type: "incident",
      id: incidentId,
    });
    expect(res.body.usage.totalTokens).toBe(51);
    expect(typeof res.body.model).toBe("string");
  });

  it("returns an honest no-answer WITHOUT calling the LLM when nothing is retrievable", async () => {
    const before = chatCalls;
    const res = await authed(app, adminToken)
      .post("/v1/rag/ask")
      .send({ question: "nonexistentxyzzy qwertyfoobar" })
      .expect(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toBe(NO_ANSWER);
    expect(res.body.usage.totalTokens).toBe(0);
    expect(chatCalls).toBe(before); // short-circuited — no generation call
  });

  it("audits rag.ask with provenance only (cited ids present, raw question absent)", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/rag/ask")
      .send({ question: `flood evacuation ${SENTINEL}` })
      .expect(200);
    expect(res.body.grounded).toBe(true);

    const rows = await sql<{ meta: string; outcome: string }[]>`
      SELECT metadata::text AS meta, outcome FROM audit_log
      WHERE action = 'rag.ask' AND actor_id = ${adminId}
      ORDER BY occurred_at DESC LIMIT 1`;
    expect(rows[0]!.outcome).toBe("success");
    expect(rows[0]!.meta).toContain("citedSources");
    expect(rows[0]!.meta).toContain(incidentId); // provenance
    expect(rows[0]!.meta).toContain("grounded");
    // Sovereignty: the raw question is NOT persisted in the audit row.
    expect(rows[0]!.meta).not.toContain(SENTINEL);
  });

  it("rejects a caller without llm:use (403)", async () => {
    const viewer = await createUser(sql, tenant); // role-less
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    await authed(app, viewerToken)
      .post("/v1/rag/ask")
      .send({ question: "flood evacuation" })
      .expect(403);
  });

  it("rejects an invalid request (empty question → 400)", async () => {
    await authed(app, adminToken)
      .post("/v1/rag/ask")
      .send({ question: "" })
      .expect(400);
  });
});

/**
 * When the LLM gateway is disabled the provider is inactive → `/v1/rag/ask` 503s
 * (mirrors the LLM gateway), regardless of retrieval.
 */
describe("RAG when the LLM gateway is disabled (P5.4)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;

  const inactiveProvider: LlmProvider = {
    active: false,
    chat: async () => {
      throw new Error("disabled");
    },
    embed: async () => {
      throw new Error("disabled");
    },
  };

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(LLM_PROVIDER).useValue(inactiveProvider),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { user } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("returns 503", async () => {
    await authed(app, adminToken)
      .post("/v1/rag/ask")
      .send({ question: "flood evacuation" })
      .expect(503);
  });
});
