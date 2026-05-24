import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Redis substrate test (P0.2).
 *
 * Asserts the API DI graph resolves a connected ioredis client. This is the
 * regression line for "did anyone accidentally unwire RedisModule" and the
 * smoke test for the boot-time PING that fails the app when Redis is
 * misconfigured.
 *
 * Tests touch a single short-lived key under the documented `cmc:test:`
 * prefix (see redis-keys.ts) so they coexist with dev / parallel runs
 * without needing FLUSHDB.
 */
describe("Redis substrate", () => {
  let app: INestApplication;
  let client: Redis;

  beforeAll(async () => {
    app = await buildTestApp();
    client = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
  });

  it("resolves the REDIS token to a connected client", () => {
    expect(client).toBeDefined();
    // ioredis exposes a string status field — 'ready' means the client
    // has completed AUTH (if any) and the server has acknowledged.
    expect(client.status).toBe("ready");
  });

  it("PING returns PONG", async () => {
    await expect(client.ping()).resolves.toBe("PONG");
  });

  it("SET/GET round-trip with TTL", async () => {
    const key = `cmc:test:p0-2:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      // EX 60: auto-expire so a crashed test never leaves debris.
      const setReply = await client.set(key, "ok", "EX", 60);
      expect(setReply).toBe("OK");
      await expect(client.get(key)).resolves.toBe("ok");
      // TTL is set; bounded between 0 and 60 inclusive.
      const ttl = await client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally {
      // Best-effort cleanup; EX guarantees eventual removal anyway.
      await client.del(key).catch(() => undefined);
    }
  });

  it("uses the expected connection name in CLIENT GETNAME", async () => {
    // Sanity-check the operational handle set in the factory. Visible in
    // `CLIENT LIST` for the operator, here for the test.
    await expect(client.client("GETNAME")).resolves.toBe("cmc-api");
  });
});
