import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
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
 * Chat (P3.12 / ADR-0057): tenant-open channels + messages, author-or-manage
 * moderation, RLS isolation, outbox emission for realtime fan-out. Real
 * Postgres + Redis.
 */
describe("Chat (/v1/chat, P3.12)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let tenantId: string;
  let adminToken: string; // tenant_admin → chat:manage
  let opToken: string; // operator → chat:read + chat:write
  let op2Token: string; // another operator (non-author probe)
  let op2Id: string;
  let viewerToken: string; // role-less
  let otherToken: string;

  async function mkChannel(name = "general"): Promise<string> {
    const res = await authed(app, adminToken)
      .post("/v1/chat/channels")
      .send({ name })
      .expect(201);
    return res.body.channel.id as string;
  }

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
    const op2 = await createUser(sql, tenant);
    await grantSystemRole(sql, op2, "operator");
    op2Id = op2.id;
    op2Token = (await loginAs(app, op2)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("creates a channel (manage), lists + gets it; non-manager 403", async () => {
    const id = await mkChannel("ops-room");
    await authed(app, opToken)
      .post("/v1/chat/channels")
      .send({ name: "nope" })
      .expect(403); // operator lacks chat:manage

    const list = await authed(app, opToken).get("/v1/chat/channels").expect(200);
    expect(list.body.channels.map((c: { id: string }) => c.id)).toContain(id);
    await authed(app, opToken).get(`/v1/chat/channels/${id}`).expect(200);
  });

  it("posts + lists messages oldest-first with a before-cursor", async () => {
    const id = await mkChannel("feed");
    for (const body of ["first", "second", "third"]) {
      await authed(app, opToken)
        .post(`/v1/chat/channels/${id}/messages`)
        .send({ body })
        .expect(201);
    }

    const page1 = await authed(app, opToken)
      .get(`/v1/chat/channels/${id}/messages?limit=2`)
      .expect(200);
    expect(page1.body.messages.map((m: { body: string }) => m.body)).toEqual([
      "second",
      "third",
    ]);
    expect(page1.body.nextBefore).not.toBeNull();

    const page2 = await authed(app, opToken)
      .get(
        `/v1/chat/channels/${id}/messages?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`,
      )
      .expect(200);
    expect(page2.body.messages.map((m: { body: string }) => m.body)).toEqual([
      "first",
    ]);
    expect(page2.body.nextBefore).toBeNull();

    // Producer side: a chat message_created event was written to the outbox.
    const ev = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox
       WHERE tenant_id = ${tenantId} AND aggregate_type = 'chat'
         AND event_type = 'message_created'`;
    expect(ev[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it("edit/delete: author ok, others 403, manager overrides", async () => {
    const id = await mkChannel("mod");
    const post = async (token: string, body: string) =>
      (
        await authed(app, token)
          .post(`/v1/chat/channels/${id}/messages`)
          .send({ body })
          .expect(201)
      ).body.message.id as string;

    const m1 = await post(opToken, "by op");
    // another operator (write but not author, not manager) → 403
    await authed(app, op2Token)
      .patch(`/v1/chat/messages/${m1}`)
      .send({ body: "hijack" })
      .expect(403);
    // author edits → ok, flagged edited
    const edited = await authed(app, opToken)
      .patch(`/v1/chat/messages/${m1}`)
      .send({ body: "by op (fixed)" })
      .expect(200);
    expect(edited.body.message.edited).toBe(true);

    // manager (admin) deletes someone else's message → 204
    await authed(app, adminToken)
      .delete(`/v1/chat/messages/${m1}`)
      .expect(204);
    // author deletes own (post a fresh one) → 204
    const m2 = await post(opToken, "ephemeral");
    await authed(app, opToken).delete(`/v1/chat/messages/${m2}`).expect(204);

    const list = await authed(app, opToken)
      .get(`/v1/chat/channels/${id}/messages`)
      .expect(200);
    expect(list.body.messages).toHaveLength(0);
  });

  it("deletes a channel (manage) and its messages", async () => {
    const id = await mkChannel("temp");
    await authed(app, opToken)
      .post(`/v1/chat/channels/${id}/messages`)
      .send({ body: "hi" })
      .expect(201);
    await authed(app, adminToken).delete(`/v1/chat/channels/${id}`).expect(204);
    await authed(app, opToken).get(`/v1/chat/channels/${id}`).expect(404);
    await authed(app, opToken)
      .get(`/v1/chat/channels/${id}/messages`)
      .expect(404);
  });

  it("threads: replies are separate from the feed + counted (P3.12b)", async () => {
    const id = await mkChannel("threads");
    const root = (
      await authed(app, opToken)
        .post(`/v1/chat/channels/${id}/messages`)
        .send({ body: "root" })
        .expect(201)
    ).body.message.id as string;
    const reply = await authed(app, opToken)
      .post(`/v1/chat/channels/${id}/messages`)
      .send({ body: "a reply", parentId: root })
      .expect(201);
    expect(reply.body.message.parentId).toBe(root);

    // Top-level feed excludes replies; the root shows replyCount.
    const feed = await authed(app, opToken)
      .get(`/v1/chat/channels/${id}/messages`)
      .expect(200);
    expect(feed.body.messages.map((m: { body: string }) => m.body)).toEqual([
      "root",
    ]);
    expect(feed.body.messages[0].replyCount).toBe(1);

    // The thread endpoint returns the reply.
    const replies = await authed(app, opToken)
      .get(`/v1/chat/messages/${root}/replies`)
      .expect(200);
    expect(replies.body.messages.map((m: { body: string }) => m.body)).toEqual([
      "a reply",
    ]);

    // No nesting: replying to a reply → 400.
    await authed(app, opToken)
      .post(`/v1/chat/channels/${id}/messages`)
      .send({ body: "nested", parentId: reply.body.message.id })
      .expect(400);
  });

  it("reactions: idempotent add, per-emoji count + mine flag (P3.12b)", async () => {
    const id = await mkChannel("react");
    const m = (
      await authed(app, opToken)
        .post(`/v1/chat/channels/${id}/messages`)
        .send({ body: "react to me" })
        .expect(201)
    ).body.message.id as string;

    await authed(app, opToken)
      .post(`/v1/chat/messages/${m}/reactions`)
      .send({ emoji: "👍" })
      .expect(200);
    // idempotent: same user + emoji again → still count 1
    const again = await authed(app, opToken)
      .post(`/v1/chat/messages/${m}/reactions`)
      .send({ emoji: "👍" })
      .expect(200);
    const r1 = again.body.message.reactions.find(
      (r: { emoji: string }) => r.emoji === "👍",
    );
    expect(r1.count).toBe(1);
    expect(r1.mine).toBe(true);

    // op2 adds the same emoji → count 2
    await authed(app, op2Token)
      .post(`/v1/chat/messages/${m}/reactions`)
      .send({ emoji: "👍" })
      .expect(200);
    const feed = await authed(app, op2Token)
      .get(`/v1/chat/channels/${id}/messages`)
      .expect(200);
    const r2 = feed.body.messages[0].reactions.find(
      (r: { emoji: string }) => r.emoji === "👍",
    );
    expect(r2.count).toBe(2);
    expect(r2.mine).toBe(true); // from op2's perspective

    // op removes theirs → count 1
    const removed = await authed(app, opToken)
      .delete(`/v1/chat/messages/${m}/reactions/${encodeURIComponent("👍")}`)
      .expect(200);
    expect(
      removed.body.message.reactions.find(
        (r: { emoji: string }) => r.emoji === "👍",
      ).count,
    ).toBe(1);
  });

  it("mentions: @user gets a notification (P3.12b)", async () => {
    const id = await mkChannel("mentions");
    await authed(app, opToken)
      .post(`/v1/chat/channels/${id}/messages`)
      .send({ body: "hey @op2 look", mentions: [op2Id] })
      .expect(201);
    const n = await sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM notifications
       WHERE user_id = ${op2Id} AND kind = 'chat.mention'`;
    expect(n[0]!.c).toBe(1);
  });

  it("enforces RBAC + tenant isolation", async () => {
    const id = await mkChannel("private-ish");
    // viewer: no chat:read / chat:write
    await authed(app, viewerToken).get("/v1/chat/channels").expect(403);
    await authed(app, viewerToken)
      .post(`/v1/chat/channels/${id}/messages`)
      .send({ body: "nope" })
      .expect(403);
    // other tenant → channel hidden by RLS → 404
    await authed(app, otherToken).get(`/v1/chat/channels/${id}`).expect(404);
  });
});
