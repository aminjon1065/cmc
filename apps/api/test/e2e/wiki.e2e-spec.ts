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

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/**
 * Wiki spaces + pages (P3.10a / ADR-0055): ltree page tree per space, TipTap
 * JSON content + derived plaintext, snapshot-per-save versions, tenant-wide
 * wiki:* RBAC, RLS isolation.
 */
describe("Wiki (/v1/wiki, P3.10a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let opToken: string; // operator → wiki:read + wiki:write, no manage
  let viewerToken: string; // role-less → no wiki perms
  let otherToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE wiki_page_versions, wiki_pages, wiki_spaces RESTART IDENTITY CASCADE`,
    );
  });

  async function mkSpace(): Promise<string> {
    const res = await authed(app, adminToken)
      .post("/v1/wiki/spaces")
      .send({ name: "Runbooks" })
      .expect(201);
    return res.body.space.id as string;
  }
  async function mkPage(
    spaceId: string,
    title: string,
    parentId?: string,
    text = "body",
  ): Promise<string> {
    const res = await authed(app, adminToken)
      .post("/v1/wiki/pages")
      .send({ spaceId, title, parentId, content: doc(text) })
      .expect(201);
    return res.body.page.id as string;
  }

  it("spaces: create, list, get, update, delete", async () => {
    const id = await mkSpace();
    const list = await authed(app, adminToken).get("/v1/wiki/spaces").expect(200);
    expect(list.body.spaces).toHaveLength(1);
    await authed(app, adminToken)
      .patch(`/v1/wiki/spaces/${id}`)
      .send({ description: "ops" })
      .expect(200);
    const got = await authed(app, adminToken)
      .get(`/v1/wiki/spaces/${id}`)
      .expect(200);
    expect(got.body.space.description).toBe("ops");
    await authed(app, adminToken).delete(`/v1/wiki/spaces/${id}`).expect(204);
    await authed(app, adminToken).get(`/v1/wiki/spaces/${id}`).expect(404);
  });

  it("pages: nested tree + content round-trip + path ordering", async () => {
    const space = await mkSpace();
    const root = await mkPage(space, "Root", undefined, "root body");
    const child = await mkPage(space, "Child", root, "child body");

    const rootPage = await authed(app, adminToken)
      .get(`/v1/wiki/pages/${root}`)
      .expect(200);
    expect(rootPage.body.page.depth).toBe(1);
    expect(rootPage.body.page.currentVersionNo).toBe(1);
    expect(rootPage.body.page.content.content[0].content[0].text).toBe(
      "root body",
    );

    const tree = await authed(app, adminToken)
      .get(`/v1/wiki/spaces/${space}/pages`)
      .expect(200);
    expect(tree.body.pages.map((p: { id: string }) => p.id)).toEqual([root, child]);
    expect(tree.body.pages.find((p: { id: string }) => p.id === child).depth).toBe(2);

    // derived plaintext is stored for search.
    const txt = await sql<{ content_text: string }[]>`
      SELECT content_text FROM wiki_pages WHERE id = ${root}`;
    expect(txt[0]!.content_text).toBe("root body");
  });

  it("update snapshots a new version; restore re-points (append-only)", async () => {
    const space = await mkSpace();
    const page = await mkPage(space, "Doc", undefined, "v1 text");

    const upd = await authed(app, adminToken)
      .patch(`/v1/wiki/pages/${page}`)
      .send({ content: doc("v2 text") })
      .expect(200);
    expect(upd.body.page.currentVersionNo).toBe(2);

    const versions = await authed(app, adminToken)
      .get(`/v1/wiki/pages/${page}/versions`)
      .expect(200);
    expect(versions.body.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1]);
    expect(versions.body.versions[0].isCurrent).toBe(true);

    const restored = await authed(app, adminToken)
      .post(`/v1/wiki/pages/${page}/versions/1/restore`)
      .expect(200);
    expect(restored.body.page.currentVersionNo).toBe(3);
    expect(restored.body.page.content.content[0].content[0].text).toBe("v1 text");
  });

  it("move re-parents a subtree + guards against cycles", async () => {
    const space = await mkSpace();
    const a = await mkPage(space, "A");
    const b = await mkPage(space, "B");
    await authed(app, adminToken)
      .post(`/v1/wiki/pages/${b}/move`)
      .send({ parentId: a })
      .expect(200);
    const tree = await authed(app, adminToken)
      .get(`/v1/wiki/spaces/${space}/pages`)
      .expect(200);
    expect(tree.body.pages.find((p: { id: string }) => p.id === b).depth).toBe(2);

    // a is now under b's... no — moving a under b (its descendant) is a cycle.
    await authed(app, adminToken)
      .post(`/v1/wiki/pages/${a}/move`)
      .send({ parentId: b })
      .expect(400);
  });

  it("deleting a page soft-deletes its subtree", async () => {
    const space = await mkSpace();
    const root = await mkPage(space, "Root");
    const child = await mkPage(space, "Child", root);
    await authed(app, adminToken).delete(`/v1/wiki/pages/${root}`).expect(204);
    await authed(app, adminToken).get(`/v1/wiki/pages/${child}`).expect(404);
    const tree = await authed(app, adminToken)
      .get(`/v1/wiki/spaces/${space}/pages`)
      .expect(200);
    expect(tree.body.pages).toHaveLength(0);
  });

  it("enforces wiki:* RBAC", async () => {
    const space = await mkSpace();
    // viewer (role-less) can't even read.
    await authed(app, viewerToken).get("/v1/wiki/spaces").expect(403);
    // operator can read + create pages (write) but not create spaces (manage).
    await authed(app, opToken).get("/v1/wiki/spaces").expect(200);
    await authed(app, opToken)
      .post("/v1/wiki/spaces")
      .send({ name: "Nope" })
      .expect(403);
    await authed(app, opToken)
      .post("/v1/wiki/pages")
      .send({ spaceId: space, title: "Op page", content: doc("x") })
      .expect(201);
  });

  it("isolates wiki across tenants (RLS → 404)", async () => {
    const space = await mkSpace();
    const page = await mkPage(space, "Secret");
    await authed(app, otherToken).get(`/v1/wiki/spaces/${space}`).expect(404);
    await authed(app, otherToken).get(`/v1/wiki/pages/${page}`).expect(404);
    expect(
      (await authed(app, otherToken).get("/v1/wiki/spaces").expect(200)).body.spaces,
    ).toHaveLength(0);
  });
});
