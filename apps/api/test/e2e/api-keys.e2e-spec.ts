import { createHash } from "crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import request from "supertest";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * API keys + combined auth (P3.9a / ADR-0054). A key authenticates the same
 * `/v1` endpoints as a user; its scopes gate via `@Authorize`. Keys are hashed
 * at rest; per-key quota → 429. Management is `api_key:manage` + user-only.
 */
describe("API keys (/v1/api-keys, P3.9a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let opToken: string; // operator — no api_key:manage
  let tenantId: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminToken = (await loginAs(app, admin)).accessToken;
    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE api_keys RESTART IDENTITY CASCADE`);
    const keys = await redis.keys("cmc:apiquota:*");
    if (keys.length) await redis.del(...keys);
  });

  async function createKey(scopes: string[]): Promise<{ id: string; secret: string }> {
    const res = await authed(app, adminToken)
      .post("/v1/api-keys")
      .send({ name: "test key", scopes })
      .expect(201);
    return { id: res.body.apiKey.id, secret: res.body.secret };
  }

  it("creates a key (secret shown once, hashed at rest) and lists it", async () => {
    const res = await authed(app, adminToken)
      .post("/v1/api-keys")
      .send({ name: "ingest", scopes: ["document:read"] })
      .expect(201);
    const secret = res.body.secret as string;
    expect(secret.startsWith("cmc_")).toBe(true);
    expect(res.body.apiKey.keyPrefix.startsWith("cmc_")).toBe(true);
    expect(res.body.apiKey.scopes).toEqual(["document:read"]);

    // Stored as a SHA-256 hash — never the plaintext.
    const rows = await sql<{ key_hash: string; key_prefix: string }[]>`
      SELECT key_hash, key_prefix FROM api_keys WHERE id = ${res.body.apiKey.id}`;
    expect(rows[0]!.key_hash).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    expect(rows[0]!.key_hash).not.toContain(secret);

    const list = await authed(app, adminToken).get("/v1/api-keys").expect(200);
    expect(list.body.apiKeys).toHaveLength(1);
    expect(list.body.apiKeys[0].id).toBe(res.body.apiKey.id);
  });

  it("authenticates an existing /v1 endpoint within the key's scopes", async () => {
    const { secret } = await createKey(["document:read"]);
    // X-API-Key header.
    await http().get("/v1/documents").set("X-API-Key", secret).expect(200);
    // Authorization: Bearer cmc_... also works.
    await http()
      .get("/v1/documents")
      .set("Authorization", `Bearer ${secret}`)
      .expect(200);
  });

  it("denies an endpoint outside the key's scopes (403)", async () => {
    const { secret } = await createKey(["document:read"]);
    // Incidents require incident:read, which this key doesn't carry.
    await http().get("/v1/incidents").set("X-API-Key", secret).expect(403);
  });

  it("rejects scopes the creator doesn't hold (overreach → 400)", async () => {
    await authed(app, adminToken)
      .post("/v1/api-keys")
      .send({ name: "bad", scopes: ["foo:bar"] }) // not a real catalog perm
      .expect(400);
  });

  it("stops authenticating once revoked (401)", async () => {
    const { id, secret } = await createKey(["document:read"]);
    await http().get("/v1/documents").set("X-API-Key", secret).expect(200);
    await authed(app, adminToken).delete(`/v1/api-keys/${id}`).expect(204);
    await http().get("/v1/documents").set("X-API-Key", secret).expect(401);
  });

  it("enforces the per-key quota (429 with Retry-After)", async () => {
    const { secret } = await createKey(["document:read"]); // limit = 5 in .env.test
    for (let i = 0; i < 5; i++) {
      await http().get("/v1/documents").set("X-API-Key", secret).expect(200);
    }
    const over = await http()
      .get("/v1/documents")
      .set("X-API-Key", secret)
      .expect(429);
    expect(over.headers["retry-after"]).toBeDefined();
  });

  it("gates key management on api_key:manage + blocks api-key principals", async () => {
    // operator lacks api_key:manage.
    await authed(app, opToken)
      .post("/v1/api-keys")
      .send({ name: "nope", scopes: ["document:read"] })
      .expect(403);

    // A key cannot manage keys, even if scoped api_key:manage.
    const { secret } = await createKey(["api_key:manage"]);
    await http()
      .get("/v1/api-keys")
      .set("X-API-Key", secret)
      .expect(403);
  });

  it("leaves JWT auth unaffected", async () => {
    await authed(app, adminToken).get("/v1/api-keys").expect(200);
  });
});
