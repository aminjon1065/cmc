import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Document versioning (P3.4 / ADR-0049): v1 at finalize, new-version upload bumps
 * the current pointer, list/download a specific version, restore (rollback), and
 * a captured SHA-256 content_hash. Real MinIO round-trips.
 */
describe("Document versions", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { user } = await createTenantWithAdmin(sql);
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE document_versions, documents RESTART IDENTITY CASCADE`,
    );
  });

  async function uploadDoc(body: Buffer): Promise<string> {
    const init = await authed(app, token)
      .post("/v1/documents/upload-init")
      .send({ name: "doc.txt", mimeType: "text/plain", sizeBytes: body.length });
    expect(init.status).toBe(201);
    const id = init.body.document.id as string;
    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "text/plain" },
    });
    expect(put.ok).toBe(true);
    await authed(app, token).post(`/v1/documents/${id}/finalize`).expect(200);
    return id;
  }

  async function addVersion(id: string, body: Buffer): Promise<number> {
    const init = await authed(app, token)
      .post(`/v1/documents/${id}/versions`)
      .send({ sizeBytes: body.length });
    expect(init.status).toBe(201);
    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(body),
      headers: { "Content-Type": "text/plain" },
    });
    expect(put.ok).toBe(true);
    const fin = await authed(app, token)
      .post(`/v1/documents/${id}/versions/finalize`)
      .expect(200);
    expect(fin.body.document.currentVersionNo).toBe(init.body.versionNo);
    return init.body.versionNo as number;
  }

  async function fetchVersion(id: string, versionNo: number): Promise<string> {
    const res = await authed(app, token)
      .get(`/v1/documents/${id}/versions/${versionNo}/download-url`)
      .expect(200);
    const r = await fetch(res.body.url as string);
    expect(r.ok).toBe(true);
    return Buffer.from(await r.arrayBuffer()).toString("utf8");
  }

  it("finalize records v1 with a content hash", async () => {
    const id = await uploadDoc(Buffer.from("hello v1"));
    const res = await authed(app, token)
      .get(`/v1/documents/${id}/versions`)
      .expect(200);
    expect(res.body.versions).toHaveLength(1);
    const v1 = res.body.versions[0];
    expect(v1.versionNo).toBe(1);
    expect(v1.isCurrent).toBe(true);
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a new version bumps current; old versions stay downloadable", async () => {
    const id = await uploadDoc(Buffer.from("content one"));
    const v2 = await addVersion(id, Buffer.from("content two — updated"));
    expect(v2).toBe(2);

    const list = await authed(app, token)
      .get(`/v1/documents/${id}/versions`)
      .expect(200);
    expect(list.body.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual(
      [2, 1],
    );
    const current = list.body.versions.find(
      (v: { isCurrent: boolean }) => v.isCurrent,
    );
    expect(current.versionNo).toBe(2);

    // Each version's bytes are intact + the document reflects v2.
    expect(await fetchVersion(id, 1)).toBe("content one");
    expect(await fetchVersion(id, 2)).toBe("content two — updated");
    const cur = await authed(app, token)
      .get(`/v1/documents/${id}/download-url`)
      .expect(200);
    const curBytes = await fetch(cur.body.url as string);
    expect(await curBytes.text()).toBe("content two — updated");

    // Distinct content → distinct hashes.
    const hashes = list.body.versions.map(
      (v: { contentHash: string }) => v.contentHash,
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("restore rolls the document back to an earlier version", async () => {
    const id = await uploadDoc(Buffer.from("original"));
    await addVersion(id, Buffer.from("revised"));

    const restored = await authed(app, token)
      .post(`/v1/documents/${id}/versions/1/restore`)
      .expect(200);
    expect(restored.body.document.currentVersionNo).toBe(1);

    // Current download now serves v1 bytes again (no new version created).
    const cur = await authed(app, token)
      .get(`/v1/documents/${id}/download-url`)
      .expect(200);
    const bytes = await fetch(cur.body.url as string);
    expect(await bytes.text()).toBe("original");
    const list = await authed(app, token)
      .get(`/v1/documents/${id}/versions`)
      .expect(200);
    expect(list.body.versions).toHaveLength(2); // restore repoints, no new row
  });

  it("404s a download for an unknown version", async () => {
    const id = await uploadDoc(Buffer.from("x"));
    await authed(app, token)
      .get(`/v1/documents/${id}/versions/99/download-url`)
      .expect(404);
  });
});
