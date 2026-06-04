import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  assignRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  LLM_PROVIDER,
  type LlmProvider,
} from "../../src/modules/llm/llm.provider";

const SENTINEL = "COPILOTSENTINEL7";
const ANSWER = "Per the incident, evacuate residents to designated shelters [1].";
const NO_ANSWER = "I could not find an answer in the available sources.";

/**
 * Per-module copilots (P5.5 / ADR-0071). The LLM provider is faked: `chat`
 * returns a fixed, citation-bearing answer and counts calls (to prove the
 * no-source path makes none). Retrieval is the real permission-aware hybrid
 * search over a seeded incident. Covers: module-scoped grounding + `[n]`→id
 * citation; the `resourceId` record anchor; the **read-perm gate** (llm:use but
 * no incident:read → honest no-answer, no leak); the metadata-only `copilot.ask`
 * audit; and RBAC. Real generation is a manual live-smoke.
 */
describe("Copilot (/v1/copilot/ask, P5.5)", () => {
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
        usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
        finishReason: "stop",
      };
    },
    embed: async (texts, model) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      model,
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };

  /** A user with ONLY llm:use (no incident:read) via a custom role. */
  async function createLlmOnlyToken(): Promise<string> {
    const u = await createUser(sql, tenant);
    const roleRows = await sql<{ id: string }[]>`
      INSERT INTO roles (tenant_id, slug, name, description, is_system)
      VALUES (${tenant.id}, 'llm-only', 'LLM only', 'llm:use only', false)
      RETURNING id`;
    const roleId = roleRows[0]!.id;
    await sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${roleId}, p.id FROM permissions p WHERE p.domain = 'llm' AND p.action = 'use'`;
    await assignRole(sql, { userId: u.id, roleId, tenantId: tenant.id });
    return (await loginAs(app, u)).accessToken;
  }

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(LLM_PROVIDER).useValue(fakeProvider),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql); // tenant_admin → llm:use + incident:*
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

  it("grounds in module-scoped retrieval and resolves [n] citations", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: "flood evacuation" })
      .expect(200);
    expect(res.body.answer).toBe(ANSWER);
    expect(res.body.grounded).toBe(true);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({
      type: "incident",
      id: incidentId,
    });
    expect(res.body.usage.totalTokens).toBe(38);
  });

  it("anchors on a specific record via resourceId (even when the query doesn't keyword-match)", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/copilot/ask")
      .send({
        module: "incidents",
        question: "give me a brief situational overview",
        resourceId: incidentId,
      })
      .expect(200);
    // Only the anchored incident is in context → the [1] citation resolves to it.
    expect(res.body.grounded).toBe(true);
    expect(res.body.citations.map((c: { id: string }) => c.id)).toContain(
      incidentId,
    );
  });

  it("a caller with llm:use but no incident:read gets an honest no-answer (no leak, no LLM call)", async () => {
    const token = await createLlmOnlyToken();
    const before = chatCalls;
    const res = await authed(app, token)
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: "flood evacuation" })
      .expect(200);
    expect(res.body.grounded).toBe(false);
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toBe(NO_ANSWER);
    expect(chatCalls).toBe(before); // no grounding data → no generation call
  });

  it("audits copilot.ask with module + provenance only (raw question absent)", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: `flood evacuation ${SENTINEL}` })
      .expect(200);
    expect(res.body.grounded).toBe(true);

    const rows = await sql<{ meta: string; outcome: string }[]>`
      SELECT metadata::text AS meta, outcome FROM audit_log
      WHERE action = 'copilot.ask' AND actor_id = ${adminId}
      ORDER BY occurred_at DESC LIMIT 1`;
    expect(rows[0]!.outcome).toBe("success");
    expect(rows[0]!.meta).toContain("incidents"); // module
    expect(rows[0]!.meta).toContain("citedSources");
    expect(rows[0]!.meta).toContain(incidentId); // provenance
    expect(rows[0]!.meta).not.toContain(SENTINEL); // raw question NOT persisted
  });

  it("rejects a caller without llm:use (403)", async () => {
    const viewer = await createUser(sql, tenant); // role-less
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    await authed(app, viewerToken)
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: "flood evacuation" })
      .expect(403);
  });

  it("rejects an invalid request (empty question → 400, unknown module → 400)", async () => {
    await authed(app, adminToken)
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: "" })
      .expect(400);
    await authed(app, adminToken)
      .post("/v1/copilot/ask")
      .send({ module: "spaceships", question: "hi" })
      .expect(400);
  });
});

/** When the LLM gateway is disabled the provider is inactive → 503. */
describe("Copilot when the LLM gateway is disabled (P5.5)", () => {
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
      .post("/v1/copilot/ask")
      .send({ module: "incidents", question: "flood evacuation" })
      .expect(503);
  });
});
