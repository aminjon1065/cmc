import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import StarterKit from "@tiptap/starter-kit";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { CollabService } from "../../src/modules/collab/collab.service";

const pmDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Build encoded Y.Doc state for a TipTap doc (the field the editor binds to). */
function encodeDoc(text: string): Uint8Array {
  const doc = TiptapTransformer.toYdoc(pmDoc(text), "default", [StarterKit]);
  return Y.encodeStateAsUpdate(doc);
}
function docText(doc: Y.Doc): string {
  const json = TiptapTransformer.fromYdoc(doc, "default") as {
    content?: Array<{ content?: Array<{ text?: string }> }>;
  };
  return JSON.stringify(json);
}

/**
 * Collaborative editing substrate (P4.1a / ADR-0060). The Hocuspocus WS server
 * is gated off in tests; these drive CollabService (auth + Yjs↔wiki persistence)
 * directly against real Postgres. Real WS sync is covered by the live smoke.
 */
describe("Collab substrate (P4.1a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let collab: CollabService;
  let tenantId: string;
  let adminToken: string;
  let opToken: string;
  let viewerToken: string;
  let otherToken: string;
  let pageId: string;
  let docName: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    collab = app.get(CollabService);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminToken = (await loginAs(app, admin)).accessToken;
    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator"); // wiki:read + wiki:write
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;

    const space = (
      await authed(app, adminToken)
        .post("/v1/wiki/spaces")
        .send({ name: "Collab" })
        .expect(201)
    ).body.space.id;
    pageId = (
      await authed(app, adminToken)
        .post("/v1/wiki/pages")
        .send({ spaceId: space, title: "Doc", content: pmDoc("seeded text") })
        .expect(201)
    ).body.page.id;
    docName = `wiki.${pageId}`;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("authorizes a wiki:write collaborator; rejects bad token / no-perm / cross-tenant / bad name", async () => {
    const ok = await collab.authorize(opToken, docName);
    expect(ok).not.toBeNull();
    expect(ok!.tenantId).toBe(tenantId);
    expect(ok!.pageId).toBe(pageId);

    expect(await collab.authorize("not-a-jwt", docName)).toBeNull();
    expect(await collab.authorize(viewerToken, docName)).toBeNull(); // no wiki:write
    expect(await collab.authorize(otherToken, docName)).toBeNull(); // page not in tenant
    expect(await collab.authorize(adminToken, "wiki.not-a-uuid")).toBeNull();
  });

  it("loadDocument seeds a fresh Y.Doc from the page's current content", async () => {
    const doc = (await collab.loadDocument(docName, tenantId)) as Y.Doc;
    expect(docText(doc)).toContain("seeded text");
    // No collab_docs row yet (seeded, not persisted until first store).
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM collab_docs WHERE name = ${docName}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("storeDocument persists Y.Doc bytes and snapshots back to the wiki page", async () => {
    await collab.storeDocument(docName, tenantId, encodeDoc("collaborated text"));

    // 1) collab_docs row holds the encoded state.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM collab_docs WHERE name = ${docName}`;
    expect(rows[0]!.n).toBe(1);

    // 2) the wiki page content + plaintext were updated (search stays current).
    const page = await authed(app, adminToken)
      .get(`/v1/wiki/pages/${pageId}`)
      .expect(200);
    expect(JSON.stringify(page.body.page.content)).toContain("collaborated text");
    const ct = await sql<{ content_text: string }[]>`
      SELECT content_text FROM wiki_pages WHERE id = ${pageId}`;
    expect(ct[0]!.content_text).toContain("collaborated text");

    // 3) loadDocument now returns the stored doc, not a fresh seed.
    const reloaded = (await collab.loadDocument(docName, tenantId)) as Y.Doc;
    expect(docText(reloaded)).toContain("collaborated text");
  });

  // ---------- P4.1b: WS connection tickets (BFF — no raw JWT in browser) ----------

  it("POST /v1/collab/ticket mints a ticket for a wiki:write user", async () => {
    const res = await authed(app, opToken)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(201);
    expect(res.body.ticket).toBeTruthy();
    expect(res.body.docName).toBe(docName);
    expect(res.body.field).toBe("default");
    expect(res.body.wsUrl).toMatch(/^wss?:\/\//);
    // HOCUSPOCUS_ENABLED is off in the default suite → client fast-fallbacks.
    expect(res.body.enabled).toBe(false);
    expect(res.body.user.id).toBeTruthy();
  });

  it("rejects ticket requests without wiki:write / cross-tenant / bad body", async () => {
    await authed(app, viewerToken)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(403); // no wiki:write
    await authed(app, opToken)
      .post("/v1/collab/ticket")
      .send({ pageId: "00000000-0000-0000-0000-000000000000" })
      .expect(404); // valid uuid, not a page in this tenant
    await authed(app, otherToken)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(404); // page not in caller's tenant
    await authed(app, opToken).post("/v1/collab/ticket").send({}).expect(400);
  });

  it("a minted ticket authorizes one WS connection, then is single-use", async () => {
    const { body } = await authed(app, opToken)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(201);
    const ctx = await collab.authorizeConnection(body.ticket, docName);
    expect(ctx).not.toBeNull();
    expect(ctx!.tenantId).toBe(tenantId);
    expect(ctx!.pageId).toBe(pageId);
    // Consumed — a replay of the same ticket is rejected (and it's not a JWT).
    expect(await collab.authorizeConnection(body.ticket, docName)).toBeNull();
  });

  it("a ticket is bound to its document name", async () => {
    const { body } = await authed(app, opToken)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(201);
    expect(
      await collab.consumeTicket(
        body.ticket,
        "wiki.00000000-0000-0000-0000-000000000000",
      ),
    ).toBeNull();
  });

  it("authorizeConnection still accepts a raw JWT (tests / live-smoke path)", async () => {
    const ctx = await collab.authorizeConnection(opToken, docName);
    expect(ctx).not.toBeNull();
    expect(ctx!.pageId).toBe(pageId);
  });
});
