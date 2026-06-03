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

const doc = (t: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

/**
 * Wiki page comments (P3.10b / ADR-0055): threaded, wiki:write to comment,
 * author-or-wiki:manage to delete, RLS-isolated.
 */
describe("Wiki comments (P3.10b)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string; // wiki:manage
  let opAToken: string; // operator (wiki:write)
  let opBToken: string; // another operator
  let viewerToken: string; // role-less
  let otherToken: string;
  let pageId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const a = await createUser(sql, tenant);
    await grantSystemRole(sql, a, "operator");
    opAToken = (await loginAs(app, a)).accessToken;
    const b = await createUser(sql, tenant);
    await grantSystemRole(sql, b, "operator");
    opBToken = (await loginAs(app, b)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;

    const space = (
      await authed(app, adminToken)
        .post("/v1/wiki/spaces")
        .send({ name: "S" })
        .expect(201)
    ).body.space.id as string;
    pageId = (
      await authed(app, adminToken)
        .post("/v1/wiki/pages")
        .send({ spaceId: space, title: "P", content: doc("x") })
        .expect(201)
    ).body.page.id as string;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE wiki_comments RESTART IDENTITY CASCADE`);
  });

  it("creates, threads, and lists comments oldest-first", async () => {
    const c1 = await authed(app, opAToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "first" })
      .expect(201);
    const reply = await authed(app, opAToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "reply", parentId: c1.body.comment.id })
      .expect(201);
    expect(reply.body.comment.parentId).toBe(c1.body.comment.id);

    const list = await authed(app, adminToken)
      .get(`/v1/wiki/pages/${pageId}/comments`)
      .expect(200);
    expect(list.body.comments.map((c: { body: string }) => c.body)).toEqual([
      "first",
      "reply",
    ]);
  });

  it("rejects a reply whose parent is on another page (400)", async () => {
    const space = (
      await authed(app, adminToken).post("/v1/wiki/spaces").send({ name: "S2" }).expect(201)
    ).body.space.id;
    const otherPage = (
      await authed(app, adminToken)
        .post("/v1/wiki/pages")
        .send({ spaceId: space, title: "P2", content: doc("y") })
        .expect(201)
    ).body.page.id;
    const c = await authed(app, opAToken)
      .post(`/v1/wiki/pages/${otherPage}/comments`)
      .send({ body: "on other page" })
      .expect(201);
    await authed(app, opAToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "bad reply", parentId: c.body.comment.id })
      .expect(400);
  });

  it("lets the author delete, blocks others, allows a manager", async () => {
    const c = await authed(app, opAToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "A's comment" })
      .expect(201);
    const id = c.body.comment.id as string;

    // Another operator (write but not manage, not author) → 403.
    await authed(app, opBToken).delete(`/v1/wiki/comments/${id}`).expect(403);
    // The author → 204.
    await authed(app, opAToken).delete(`/v1/wiki/comments/${id}`).expect(204);

    // A manager can delete someone else's.
    const c2 = await authed(app, opAToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "A's second" })
      .expect(201);
    await authed(app, adminToken)
      .delete(`/v1/wiki/comments/${c2.body.comment.id}`)
      .expect(204);

    const list = await authed(app, adminToken)
      .get(`/v1/wiki/pages/${pageId}/comments`)
      .expect(200);
    expect(list.body.comments).toHaveLength(0);
  });

  it("enforces RBAC + tenant isolation", async () => {
    // viewer (no wiki:read) can't list; (no wiki:write) can't comment.
    await authed(app, viewerToken)
      .get(`/v1/wiki/pages/${pageId}/comments`)
      .expect(403);
    await authed(app, viewerToken)
      .post(`/v1/wiki/pages/${pageId}/comments`)
      .send({ body: "nope" })
      .expect(403);
    // other tenant → page hidden by RLS → 404.
    await authed(app, otherToken)
      .get(`/v1/wiki/pages/${pageId}/comments`)
      .expect(404);
  });
});
