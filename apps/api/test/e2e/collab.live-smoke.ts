import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * LIVE SMOKE (not in the default suite). The collab e2e drives CollabService;
 * THIS exercises the real Hocuspocus WS: two clients sync an edit through the
 * server and it persists/snapshots to the wiki page. The server is gated solely
 * on HOCUSPOCUS_ENABLED, so this boots a light test-mode app (only pg+redis+
 * minio needed — no temporal/opensearch/clickhouse). Run with infra up:
 *
 *   cd apps/api && HOCUSPOCUS_ENABLED=true \
 *     HOCUSPOCUS_SNAPSHOT_DEBOUNCE_MS=300 NODE_OPTIONS=--experimental-vm-modules \
 *     npx jest --config test/jest-e2e.config.js --testRegex 'collab\.live-smoke\.ts$' --forceExit
 */
const PORT = 3002;

function onceSynced(p: HocuspocusProvider): Promise<void> {
  return new Promise((res) => {
    if (p.synced) return res();
    p.on("synced", () => res());
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LIVE: collab over real Hocuspocus WS", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  let pageId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    token = (await loginAs(app, user)).accessToken;
    const space = (
      await authed(app, token).post("/v1/wiki/spaces").send({ name: "Live" }).expect(201)
    ).body.space.id;
    pageId = (
      await authed(app, token)
        .post("/v1/wiki/pages")
        .send({ spaceId: space, title: "Live", content: { type: "doc", content: [] } })
        .expect(201)
    ).body.page.id;
  }, 180_000);

  afterAll(async () => {
    if (app) await Promise.race([app.close(), sleep(8000)]);
    if (sql) await sql.end({ timeout: 2 });
  }, 30_000);

  it("syncs an edit between two clients and persists it to the wiki page", async () => {
    const docName = `wiki.${pageId}`;
    // @hocuspocus/provider uses the global WebSocket; ensure one exists (Node).
    if (!(globalThis as { WebSocket?: unknown }).WebSocket) {
      (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
    }
    const mk = (doc: Y.Doc, tok: string) =>
      new HocuspocusProvider({
        url: `ws://127.0.0.1:${PORT}`,
        name: docName,
        document: doc,
        token: tok,
      });

    // Client A authenticates the browser way: a single-use BFF ticket (no raw
    // JWT). Client B uses a raw JWT (tests path). Both must be accepted.
    const ticketRes = await authed(app, token)
      .post("/v1/collab/ticket")
      .send({ pageId })
      .expect(201);
    expect(ticketRes.body.enabled).toBe(true); // server is up in this smoke
    const aTicket = ticketRes.body.ticket as string;

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = mk(docA, aTicket);
    const b = mk(docB, token);
    await Promise.all([onceSynced(a), onceSynced(b)]);

    // Client A "types" a paragraph into the shared TipTap fragment.
    const frag = docA.getXmlFragment("default");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("live collab text")]);
    frag.insert(frag.length, [para]);

    // It propagates to client B over the wire.
    let bText = "";
    for (let i = 0; i < 40 && !bText.includes("live collab text"); i++) {
      await sleep(150);
      bText = JSON.stringify(TiptapTransformer.fromYdoc(docB, "default"));
    }
    expect(bText).toContain("live collab text");

    // And the server snapshots it back to the wiki page (debounced).
    let persisted = "";
    for (let i = 0; i < 40 && !persisted.includes("live collab text"); i++) {
      await sleep(200);
      const rows = await sql<{ content_text: string }[]>`
        SELECT content_text FROM wiki_pages WHERE id = ${pageId}`;
      persisted = rows[0]?.content_text ?? "";
    }
    expect(persisted).toContain("live collab text");

    a.destroy();
    b.destroy();
    console.log("LIVE collab OK: synced + persisted");
  }, 30_000);
});
