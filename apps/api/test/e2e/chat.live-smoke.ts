import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { WebSocket } from "ws";
import {
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  type RealtimeServerMessage,
} from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * LIVE SMOKE (not in the default suite — `.live-smoke.ts`). The chat e2e proves
 * the producer side (outbox emit); THIS proves the full realtime chain over real
 * NATS: HTTP post → outbox → relay → NATS → P2.3 fan-out → WebSocket. Run with
 * real NATS + Redis + Postgres up:
 *
 *   cd apps/api && NATS_ENABLED=true REALTIME_ENABLED=true NODE_ENV=development \
 *     NODE_OPTIONS=--experimental-vm-modules npx jest --config test/jest-e2e.config.js \
 *     --testRegex 'chat\.live-smoke\.ts$' --forceExit
 */
class WsClient {
  readonly ws: WebSocket;
  readonly openPromise: Promise<void>;
  private readonly inbox: RealtimeServerMessage[] = [];
  private readonly waiters: Array<{
    type: string;
    resolve: (m: RealtimeServerMessage) => void;
  }> = [];

  constructor(url: string, protocols: string[]) {
    this.ws = new WebSocket(url, protocols);
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
    });
    this.openPromise.catch(() => undefined);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as RealtimeServerMessage;
      const idx = this.waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.inbox.push(msg);
    });
  }

  waitFor(type: string, timeoutMs = 15000): Promise<RealtimeServerMessage> {
    const idx = this.inbox.findIndex((m) => m.type === type);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout waiting for "${type}"`)),
        timeoutMs,
      );
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

describe("LIVE: chat realtime over real NATS→WS", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let url: string;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}${REALTIME_PATH}`;
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    token = (await loginAs(app, user)).accessToken;
  }, 90_000); // full-live boot (NATS + relay + fan-out) is slower than the default

  afterAll(async () => {
    // Cap app.close() — under the full-live config NATS/relay drains can be
    // slow; --forceExit reaps the rest. This is a manual smoke, not CI.
    await Promise.race([
      app.close(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    await sql.end({ timeout: 2 });
  }, 30_000);

  it("delivers a posted message to a chat:read subscriber", async () => {
    const c = new WsClient(url, [REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");
    c.send({ type: "subscribe", subjects: [`tenant.${tenantId}.chat.>`] });
    const sub = await c.waitFor("subscribed");
    expect(JSON.stringify(sub)).toContain("chat"); // accepted (chat:read)

    const channelId = (
      await authed(app, token)
        .post("/v1/chat/channels")
        .send({ name: "live" })
        .expect(201)
    ).body.channel.id;
    await authed(app, token)
      .post(`/v1/chat/channels/${channelId}/messages`)
      .send({ body: "hello over the wire" })
      .expect(201);

    // Force the outbox→NATS relay so we don't wait on the poll interval.
    await authed(app, token).post("/v1/events/relay/flush").expect(200);

    // Several chat events fan out (channel_created, then message_created) —
    // wait specifically for the message one.
    // The fan-out delivers the full event envelope as the WS frame's `payload`;
    // the chat fields live under `payload.payload` (the producer's payload).
    type ChatEvt = RealtimeServerMessage & {
      subject: string;
      payload: { payload?: { body?: string; channelId?: string } };
    };
    let evt: ChatEvt | null = null;
    for (let i = 0; i < 6 && !evt; i++) {
      const e = (await c.waitFor("event")) as ChatEvt;
      if (e.subject.includes("chat.message_created")) evt = e;
    }
    expect(evt).not.toBeNull();
    expect(evt!.payload.payload?.body).toBe("hello over the wire");
    expect(evt!.payload.payload?.channelId).toBe(channelId);
    c.close();
    console.log("LIVE chat realtime OK:", evt!.subject);
  }, 30_000);
});
