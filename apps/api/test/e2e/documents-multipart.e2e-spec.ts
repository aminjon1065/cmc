import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, createUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/** PUT one part to its pre-signed MinIO URL; return the part ETag. */
async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: "PUT", body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`part PUT failed: ${res.status}`);
  const etag = res.headers.get("etag");
  if (!etag) throw new Error("part PUT returned no ETag");
  return etag;
}

/**
 * S3 multipart upload (P2.12 / ADR-0042): the full init → pre-signed part PUTs →
 * complete flow against real MinIO, plus abort and RBAC. The test part size is
 * 5 MiB (`.env.test`), so a >5 MiB file genuinely spans two parts.
 */
describe("Documents — multipart upload", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    adminToken = (await loginAs(app, admin)).accessToken;
    const viewer = await createUser(sql, tenant); // role-less → no document:write
    viewerToken = (await loginAs(app, viewer)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE documents RESTART IDENTITY CASCADE`);
  });

  it("uploads a small file as a single part", async () => {
    const body = Buffer.alloc(1000, "h");
    const init = await authed(app, adminToken)
      .post("/v1/documents/multipart/init")
      .send({ name: "small.bin", mimeType: "application/octet-stream", sizeBytes: body.length });
    expect(init.status).toBe(201);
    expect(init.body.parts).toHaveLength(1);
    expect(init.body.document.status).toBe("uploading");
    const id = init.body.document.id as string;

    const etag = await putPart(init.body.parts[0].url, body);

    const done = await authed(app, adminToken)
      .post(`/v1/documents/${id}/multipart/complete`)
      .send({ parts: [{ partNumber: 1, etag }] });
    expect(done.status).toBe(200);
    expect(done.body.document.status).toBe("ready");
    expect(done.body.document.sizeBytes).toBe(1000);

    // Download + verify the bytes round-trip.
    const dl = await authed(app, adminToken).get(`/v1/documents/${id}/download-url`);
    const got = await fetch(dl.body.url);
    expect((await got.arrayBuffer()).byteLength).toBe(1000);
  });

  it("uploads a >5 MiB file across two parts", async () => {
    const part1 = Buffer.alloc(5 * 1024 * 1024, "a"); // = part size
    const part2 = Buffer.alloc(120, "b");
    const total = part1.length + part2.length;

    const init = await authed(app, adminToken)
      .post("/v1/documents/multipart/init")
      .send({ name: "big.bin", mimeType: "application/octet-stream", sizeBytes: total });
    expect(init.body.parts).toHaveLength(2);
    expect(init.body.partSize).toBe(5 * 1024 * 1024);
    const id = init.body.document.id as string;

    const etag1 = await putPart(init.body.parts[0].url, part1);
    const etag2 = await putPart(init.body.parts[1].url, part2);

    const done = await authed(app, adminToken)
      .post(`/v1/documents/${id}/multipart/complete`)
      .send({
        parts: [
          { partNumber: 1, etag: etag1 },
          { partNumber: 2, etag: etag2 },
        ],
      });
    expect(done.status).toBe(200);
    expect(done.body.document.sizeBytes).toBe(total);

    const dl = await authed(app, adminToken).get(`/v1/documents/${id}/download-url`);
    const got = await fetch(dl.body.url);
    expect((await got.arrayBuffer()).byteLength).toBe(total);
  }, 30_000);

  it("aborts an in-flight multipart upload", async () => {
    const init = await authed(app, adminToken)
      .post("/v1/documents/multipart/init")
      .send({ name: "abort.bin", mimeType: "application/octet-stream", sizeBytes: 500 });
    const id = init.body.document.id as string;

    await authed(app, adminToken)
      .post(`/v1/documents/${id}/multipart/abort`)
      .expect(204);

    const after = await authed(app, adminToken).get(`/v1/documents/${id}`);
    expect(after.body.document.status).toBe("failed");
  });

  it("requires document:write (role-less user → 403)", async () => {
    await authed(app, viewerToken)
      .post("/v1/documents/multipart/init")
      .send({ name: "x.bin", mimeType: "application/octet-stream", sizeBytes: 10 })
      .expect(403);
  });
});
