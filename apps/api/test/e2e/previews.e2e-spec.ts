import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import sharp from "sharp";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  PREVIEW_QUEUE,
  type PreviewJob,
  type PreviewQueue,
} from "../../src/modules/previews/preview.queue";
import { PreviewService } from "../../src/modules/previews/preview.service";
import { StorageService } from "../../src/modules/storage/storage.service";

/**
 * Preview generation (P2.13 / ADR-0043). The BullMQ queue is faked (capturing),
 * so finalize's best-effort enqueue is observable; image preview generation runs
 * for real (sharp → WebP → MinIO). PDF/video/audio are skipped without their
 * toolchain.
 */
describe("Previews", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let token: string;
  let tenantId: string;
  let adminId: string;
  let previews: PreviewService;
  let storage: StorageService;
  const bucket = "cmc-files";
  const enqueued: string[] = [];

  const fakeQueue: PreviewQueue = {
    active: true,
    enqueue: async (job: PreviewJob) => {
      enqueued.push(job.documentId);
    },
    close: async () => {},
  };

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(PREVIEW_QUEUE).useValue(fakeQueue),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    previews = app.get(PreviewService);
    storage = app.get(StorageService);
    await truncateAll(sql, redis);
    const { tenant, user } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminId = user.id;
    token = (await loginAs(app, user)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    enqueued.length = 0;
    await sql.unsafe(`TRUNCATE documents RESTART IDENTITY CASCADE`);
  });

  it("enqueues on finalize and generates a WebP image preview", async () => {
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .png()
      .toBuffer();

    const init = await authed(app, token)
      .post("/v1/documents/upload-init")
      .send({ name: "photo.png", mimeType: "image/png", sizeBytes: png.length });
    expect(init.status).toBe(201);
    const id = init.body.document.id as string;

    const put = await fetch(init.body.upload.url, {
      method: "PUT",
      body: new Uint8Array(png),
      headers: { "Content-Type": "image/png" },
    });
    expect(put.ok).toBe(true);

    await authed(app, token).post(`/v1/documents/${id}/finalize`).expect(200);
    // Finalize enqueued a preview job (best-effort seam).
    expect(enqueued).toContain(id);

    // Run the generation directly (what the worker would do).
    const previewKey = await previews.generatePreview(tenantId, id);
    expect(previewKey).toMatch(/\.webp$/);

    // The preview object exists and is a real WebP (RIFF magic).
    const head = await storage.head({ bucket, key: previewKey! });
    expect(head.exists).toBe(true);
    const bytes = await storage.getObjectBytes({ bucket, key: previewKey! });
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    // The preview key is recorded in the document metadata.
    const rows = await sql<
      { metadata: { previews?: { image?: string } } | null }[]
    >`SELECT metadata FROM documents WHERE id = ${id}`;
    expect(rows[0]!.metadata?.previews?.image).toBe(previewKey);

    // The document contract now advertises the preview kind.
    const got = await authed(app, token).get(`/v1/documents/${id}`).expect(200);
    expect(got.body.document.previewKinds).toContain("image");

    // And a signed preview URL is issued.
    const signed = await authed(app, token)
      .get(`/v1/documents/${id}/preview-url`)
      .expect(200);
    expect(signed.body.method).toBe("GET");
    expect(typeof signed.body.url).toBe("string");
    expect(signed.body.url).toContain(previewKey!);
    // The signed URL actually fetches the WebP bytes.
    const fetched = await fetch(signed.body.url as string);
    expect(fetched.ok).toBe(true);
    const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
    expect(fetchedBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  }, 30_000);

  it("returns 404 for preview-url when no preview exists", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, 'plain.bin', 'application/octet-stream', ${bucket},
        ${"tenants/" + tenantId + "/documents/none"}, 'ready', ${adminId})
      RETURNING id`;
    await authed(app, token)
      .get(`/v1/documents/${rows[0]!.id}/preview-url`)
      .expect(404);
  });

  it("skips preview generation for non-image kinds", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, mime_type, storage_bucket, storage_key, status, uploaded_by)
      VALUES (${tenantId}, 'doc.pdf', 'application/pdf', ${bucket},
        ${"tenants/" + tenantId + "/documents/x"}, 'ready', ${adminId})
      RETURNING id`;
    const previewKey = await previews.generatePreview(tenantId, rows[0]!.id);
    expect(previewKey).toBeNull();
  });
});
