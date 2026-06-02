import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { WebSocket } from "ws";
import {
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
} from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenant,
  createTenantWithAdmin,
  createUser,
} from "../helpers/test-fixtures";
import { loginAs } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { RealtimeRegistryService } from "../../src/modules/realtime/realtime-registry.service";
import {
  isSubjectWithinTenant,
  subjectMatches,
} from "../../src/modules/realtime/subject-match";
import { requiredPermissionForSubject } from "../../src/modules/realtime/subject-permission";

/** Poll `predicate` until true or timeout. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Thin test client: tracks the open/close state and lets a test await frames. */
class WsClient {
  readonly ws: WebSocket;
  readonly openPromise: Promise<void>;
  closeCode: number | null = null;
  private readonly inbox: RealtimeServerMessage[] = [];
  private readonly waiters: Array<{
    type: RealtimeServerMessage["type"];
    resolve: (m: RealtimeServerMessage) => void;
  }> = [];

  constructor(url: string, protocols?: string | string[]) {
    this.ws = new WebSocket(url, protocols);
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
      this.ws.once("close", (code) => reject(new Error(`closed:${code}`)));
    });
    // Don't let a rejection (expected in the auth-reject test) go unhandled.
    this.openPromise.catch(() => undefined);
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as RealtimeServerMessage;
      const idx = this.waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.inbox.push(msg);
    });
    this.ws.on("close", (code) => {
      this.closeCode = code;
    });
  }

  waitFor<T extends RealtimeServerMessage["type"]>(
    type: T,
    timeoutMs = 3000,
  ): Promise<Extract<RealtimeServerMessage, { type: T }>> {
    const idx = this.inbox.findIndex((m) => m.type === type);
    if (idx >= 0) {
      return Promise.resolve(
        this.inbox.splice(idx, 1)[0] as Extract<
          RealtimeServerMessage,
          { type: T }
        >,
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for "${type}"`)),
        timeoutMs,
      );
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<RealtimeServerMessage, { type: T }>);
        },
      });
    });
  }

  send(msg: RealtimeClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

/**
 * Realtime WebSocket gateway (P2.3a / ADR-0035). Pure subject-matching + the
 * live socket protocol: authenticated connect (subprotocol + query token),
 * unauthenticated rejection, tenant-scoped subscriptions, and the broadcast
 * fan-out path that P2.3b drives from the event plane.
 */
describe("subjectMatches / tenant scope (pure)", () => {
  it("matches literals, single (*) and tail (>) wildcards", () => {
    const s = "tenant.t1.incident.created.v1";
    expect(subjectMatches("tenant.t1.incident.created.v1", s)).toBe(true);
    expect(subjectMatches("tenant.t1.incident.*.v1", s)).toBe(true);
    expect(subjectMatches("tenant.t1.incident.>", s)).toBe(true);
    expect(subjectMatches("tenant.*.incident.created.v1", s)).toBe(true);
    expect(subjectMatches("tenant.>", s)).toBe(true);
  });

  it("rejects non-matches and length mismatches", () => {
    const s = "tenant.t1.incident.created.v1";
    expect(subjectMatches("tenant.t2.incident.created.v1", s)).toBe(false);
    expect(subjectMatches("tenant.t1.document.created.v1", s)).toBe(false);
    expect(subjectMatches("tenant.t1.incident.created", s)).toBe(false); // shorter
    expect(subjectMatches("tenant.t1.incident.created.v1.extra", s)).toBe(false);
    expect(subjectMatches("tenant.t1.incident.>", "tenant.t1.incident")).toBe(
      false,
    ); // > needs ≥1 trailing
  });

  it("confines subscriptions to the connection's own tenant", () => {
    expect(isSubjectWithinTenant("tenant.t1.incident.>", "t1")).toBe(true);
    expect(isSubjectWithinTenant("tenant.t2.incident.>", "t1")).toBe(false);
    expect(isSubjectWithinTenant("tenant.*.incident.>", "t1")).toBe(false);
    expect(isSubjectWithinTenant("tenant.>", "t1")).toBe(false);
    expect(isSubjectWithinTenant("tenant.system.incident.>", "t1")).toBe(false);
    expect(isSubjectWithinTenant("incident.created", "t1")).toBe(false);
  });

  it("maps aggregate types to required permissions (fail-closed)", () => {
    expect(requiredPermissionForSubject("tenant.t1.incident.created.v1")).toBe(
      "incident:read",
    );
    expect(requiredPermissionForSubject("tenant.t1.incident.>")).toBe(
      "incident:read",
    );
    // No mapping yet → null → subscription rejected.
    expect(
      requiredPermissionForSubject("tenant.t1.document.created.v1"),
    ).toBeNull();
    // Wildcard / tail in the aggregate position → must name it → null.
    expect(requiredPermissionForSubject("tenant.t1.*.created.v1")).toBeNull();
    expect(requiredPermissionForSubject("tenant.t1.>")).toBeNull();
  });
});

describe("Realtime WebSocket gateway", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let registry: RealtimeRegistryService;
  let url: string;
  let token: string;
  let limitedToken: string;
  let tenantId: string;
  let userId: string;
  let otherTenantId: string;
  const clients: WsClient[] = [];

  function open(protocols?: string | string[], query = ""): WsClient {
    const c = new WsClient(`${url}${query}`, protocols);
    clients.push(c);
    return c;
  }

  beforeAll(async () => {
    app = await buildTestApp();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}${REALTIME_PATH}`;
    registry = app.get(RealtimeRegistryService);
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);

    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    userId = user.id;
    token = (await loginAs(app, user)).accessToken;
    otherTenantId = (await createTenant(sql)).id;
    // A role-less user in the SAME tenant: valid session (can connect) but
    // holds no permissions — used to prove per-subscription RBAC (P2.3b).
    const limited = await createUser(sql, tenant);
    limitedToken = (await loginAs(app, limited)).accessToken;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await app.close();
    await sql.end({ timeout: 2 });
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await waitUntil(() => registry.stats().connections === 0);
  });

  it("accepts an authenticated connection (subprotocol) and greets it", async () => {
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    const welcome = await c.waitFor("welcome");
    expect(welcome.userId).toBe(userId);
    expect(welcome.tenantId).toBe(tenantId);
    expect(welcome.subscriptions).toEqual([]);
  });

  it("accepts the access_token query-param fallback", async () => {
    const c = open(undefined, `?access_token=${token}`);
    await c.openPromise;
    const welcome = await c.waitFor("welcome");
    expect(welcome.tenantId).toBe(tenantId);
  });

  it("rejects an unauthenticated connection (no 101)", async () => {
    const c = open(); // no token at all
    await expect(c.openPromise).rejects.toBeDefined();
    expect(registry.stats().connections).toBe(0);
  });

  it("rejects a connection bearing a garbage token", async () => {
    const c = open([REALTIME_SUBPROTOCOL, "not-a-real-jwt"]);
    await expect(c.openPromise).rejects.toBeDefined();
  });

  it("accepts own-tenant subscriptions and rejects cross-tenant/wildcard", async () => {
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");

    const own = `tenant.${tenantId}.incident.>`;
    const cross = `tenant.${otherTenantId}.incident.>`;
    const wild = "tenant.*.incident.>";
    c.send({ type: "subscribe", subjects: [own, cross, wild] });

    const ack = await c.waitFor("subscribed");
    expect(ack.accepted).toEqual([own]);
    expect(ack.rejected.sort()).toEqual([cross, wild].sort());
  });

  it("rejects an own-tenant subscription the user lacks RBAC for", async () => {
    // Role-less user: tenant scope passes, but no `incident:read` → rejected.
    const c = open([REALTIME_SUBPROTOCOL, limitedToken]);
    await c.openPromise;
    await c.waitFor("welcome");
    const subject = `tenant.${tenantId}.incident.>`;
    c.send({ type: "subscribe", subjects: [subject] });
    const ack = await c.waitFor("subscribed");
    expect(ack.accepted).toEqual([]);
    expect(ack.rejected).toEqual([subject]);
  });

  it("delivers matching events and isolates non-matching / cross-tenant", async () => {
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");
    c.send({ type: "subscribe", subjects: [`tenant.${tenantId}.incident.>`] });
    await c.waitFor("subscribed");

    const subject = `tenant.${tenantId}.incident.created.v1`;
    expect(registry.broadcast(subject, { id: "inc-1" })).toBe(1);
    const evt = await c.waitFor("event");
    expect(evt.subject).toBe(subject);
    expect(evt.payload).toEqual({ id: "inc-1" });

    // Not subscribed to documents → no delivery; other tenant → no delivery.
    expect(
      registry.broadcast(`tenant.${tenantId}.document.created.v1`, { id: "d" }),
    ).toBe(0);
    expect(
      registry.broadcast(`tenant.${otherTenantId}.incident.created.v1`, {
        id: "x",
      }),
    ).toBe(0);
  });

  it("stops delivering after unsubscribe", async () => {
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");
    const subject = `tenant.${tenantId}.incident.created.v1`;
    c.send({ type: "subscribe", subjects: [subject] });
    await c.waitFor("subscribed");
    expect(registry.broadcast(subject, { id: "a" })).toBe(1);
    await c.waitFor("event");

    c.send({ type: "unsubscribe", subjects: [subject] });
    await c.waitFor("unsubscribed");
    expect(registry.broadcast(subject, { id: "b" })).toBe(0);
  });

  it("replies to a ping with a pong", async () => {
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");
    c.send({ type: "ping" });
    await c.waitFor("pong");
  });

  it("exposes gateway counts at GET /v1/realtime/status (tenant:manage)", async () => {
    const request = (await import("supertest")).default;
    const c = open([REALTIME_SUBPROTOCOL, token]);
    await c.openPromise;
    await c.waitFor("welcome");
    c.send({ type: "subscribe", subjects: [`tenant.${tenantId}.incident.>`] });
    await c.waitFor("subscribed");
    await waitUntil(() => registry.stats().subscriptions === 1);

    const res = await request(app.getHttpServer())
      .get("/v1/realtime/status")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.connections).toBeGreaterThanOrEqual(1);
    expect(res.body.subscriptions).toBeGreaterThanOrEqual(1);
  });
});
