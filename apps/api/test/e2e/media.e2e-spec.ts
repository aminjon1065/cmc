import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConfigService } from "@nestjs/config";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { StorageService } from "../../src/modules/storage/storage.service";

/**
 * Media management substrate (P4.5a / ADR-0063). Transcoding is gated off in
 * tests (the queue is a noop, ffmpeg never runs); these drive the rooms/asset
 * model + the BFF HLS proxy against real Postgres + MinIO. Real ffmpeg→HLS is a
 * manual/live concern.
 */
describe("Media assets (P4.5a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let storage: StorageService;
  let bucket: string;
  let tenantId: string;
  let opUserId: string;
  let opToken: string;
  let viewerToken: string;
  let otherToken: string;
  let documentId: string;

  async function seedDocument(tid: string, uploadedBy: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO documents (tenant_id, name, mime_type, storage_bucket, storage_key, uploaded_by, status)
      VALUES (${tid}, 'clip.mp4', 'video/mp4', ${bucket}, 'docs/clip.mp4', ${uploadedBy}, 'available')
      RETURNING id`;
    return row!.id;
  }

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    storage = app.get(StorageService);
    bucket = app.get(ConfigService).get<string>("S3_BUCKET_FILES") as string;
    await truncateAll(sql, redis);
    const { tenant } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    const op = await createUser(sql, tenant);
    opUserId = op.id;
    await grantSystemRole(sql, op, "operator"); // media:read + media:write
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
    documentId = await seedDocument(tenantId, opUserId);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  it("requests a transcode → a pending asset; lists + fetches it", async () => {
    const res = await authed(app, opToken)
      .post("/v1/media/transcode")
      .send({ documentId })
      .expect(201);
    const asset = res.body.asset;
    expect(asset.documentId).toBe(documentId);
    expect(asset.status).toBe("pending");
    expect(asset.kind).toBe("video");

    const list = await authed(app, opToken)
      .get(`/v1/media/assets?documentId=${documentId}`)
      .expect(200);
    expect(list.body.assets.map((a: { id: string }) => a.id)).toContain(asset.id);

    const got = await authed(app, opToken)
      .get(`/v1/media/assets/${asset.id}`)
      .expect(200);
    expect(got.body.asset.id).toBe(asset.id);
  });

  it("enforces media RBAC + unknown document / cross-tenant → 404", async () => {
    await authed(app, viewerToken).get("/v1/media/assets").expect(403);
    await authed(app, viewerToken)
      .post("/v1/media/transcode")
      .send({ documentId })
      .expect(403);
    await authed(app, opToken)
      .post("/v1/media/transcode")
      .send({ documentId: "00000000-0000-0000-0000-000000000000" })
      .expect(404);
    // The other tenant cannot transcode our document (RLS → not found).
    await authed(app, otherToken)
      .post("/v1/media/transcode")
      .send({ documentId })
      .expect(404);
  });

  it("stores a watermark on the transcode request (P4.5c)", async () => {
    const res = await authed(app, opToken)
      .post("/v1/media/transcode")
      .send({ documentId, watermark: "CMC · CONFIDENTIAL" })
      .expect(201);
    expect(res.body.asset.watermark).toBe("CMC · CONFIDENTIAL");
    const plain = await authed(app, opToken)
      .post("/v1/media/transcode")
      .send({ documentId })
      .expect(201);
    expect(plain.body.asset.watermark).toBeNull();
  });

  it("streams HLS via the BFF proxy (playlist rewrite + segment bytes)", async () => {
    // Seed a ready asset + upload a fake HLS playlist + segment to MinIO.
    const prefix = `media/${tenantId}/seed-asset`;
    const playlistKey = `${prefix}/index.m3u8`;
    const playlist =
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n";
    await storage.putObject({
      bucket,
      key: playlistKey,
      body: Buffer.from(playlist),
      contentType: "application/vnd.apple.mpegurl",
    });
    await storage.putObject({
      bucket,
      key: `${prefix}/seg0.ts`,
      body: Buffer.from("fake-ts-bytes"),
      contentType: "video/mp2t",
    });
    const [asset] = await sql<{ id: string }[]>`
      INSERT INTO media_assets (tenant_id, document_id, kind, status, playlist_key)
      VALUES (${tenantId}, ${documentId}, 'video', 'ready', ${playlistKey})
      RETURNING id`;

    const pl = await authed(app, opToken)
      .get(`/v1/media/assets/${asset!.id}/playlist.m3u8`)
      .expect(200);
    expect(pl.headers["content-type"]).toContain("mpegurl");
    expect(pl.text).toContain("seg/seg0.ts"); // segment URI rewritten to the proxy
    expect(pl.text).not.toMatch(/^seg0\.ts$/m);

    const seg = await authed(app, opToken)
      .get(`/v1/media/assets/${asset!.id}/seg/seg0.ts`)
      .buffer(true)
      .expect(200);
    const segBody = Buffer.isBuffer(seg.body)
      ? seg.body.toString("utf8")
      : String(seg.text ?? "");
    expect(segBody).toBe("fake-ts-bytes");

    // Invalid segment name is rejected; cross-tenant cannot stream.
    await authed(app, opToken)
      .get(`/v1/media/assets/${asset!.id}/seg/evil.exe`)
      .expect(400);
    await authed(app, otherToken)
      .get(`/v1/media/assets/${asset!.id}/playlist.m3u8`)
      .expect(404);
  });
});
