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
import { FolderAccessService } from "../../src/modules/folders/folder-access.service";
import {
  SEARCH_INDEX,
  type SearchHit,
  type SearchIndex,
} from "../../src/modules/search/search-index";

/**
 * Federated /v1/search (P3.7 / ADR-0052): documents come from OpenSearch (faked
 * seam here) when enabled, incidents/cases from Postgres FTS, fused by RRF. The
 * documents domain is folder-access filtered in the federated endpoint too —
 * closing the P3.3b gap the original P2.11 search had. `active` toggles the
 * Postgres fallback.
 */
describe("Federated search (/v1/search, P3.7)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let access: FolderAccessService;
  let tenant: Awaited<ReturnType<typeof createTenantWithAdmin>>["tenant"];
  let tenantId: string;
  let adminId: string;
  let adminToken: string;
  let opToken: string; // operator → reads, no folder:manage
  const bucket = "cmc-files";

  let indexActive = true;
  let cannedHits: SearchHit[] = [];
  const fakeIndex: SearchIndex = {
    get active() {
      return indexActive;
    },
    async ensureIndex() {},
    async indexDocument() {},
    async deleteDocument() {},
    async search() {
      return cannedHits;
    },
    async ping() {
      return true;
    },
    async close() {},
  };

  async function seedDoc(
    name: string,
    description: string,
    folderId: string | null = null,
  ): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO documents
        (tenant_id, name, description, mime_type, storage_bucket, storage_key, status, uploaded_by, folder_id)
      VALUES (${tenantId}, ${name}, ${description}, 'application/pdf', ${bucket},
        ${"tenants/" + tenantId + "/documents/" + name}, 'ready', ${adminId}, ${folderId})
      RETURNING id`;
    return rows[0]!.id;
  }

  const mkFolder = async (name: string): Promise<string> => {
    const res = await authed(app, adminToken)
      .post("/v1/folders")
      .send({ name })
      .expect(201);
    return res.body.folder.id as string;
  };
  const restrict = (id: string) =>
    authed(app, adminToken)
      .patch(`/v1/folders/${id}/restrict`)
      .send({ restricted: true })
      .expect(200);
  const hit = (id: string, score: number): SearchHit => ({
    id,
    score,
    folderId: null,
  });

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(SEARCH_INDEX).useValue(fakeIndex),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    access = app.get(FolderAccessService);
    await truncateAll(sql, redis);

    const created = await createTenantWithAdmin(sql);
    tenant = created.tenant;
    tenantId = tenant.id;
    adminId = created.user.id;
    adminToken = (await loginAs(app, created.user)).accessToken;

    const op = await createUser(sql, tenant);
    await grantSystemRole(sql, op, "operator");
    opToken = (await loginAs(app, op)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    indexActive = true;
    cannedHits = [];
    await sql.unsafe(
      `TRUNCATE folder_grants, case_activity, cases, incidents, documents, folders RESTART IDENTITY CASCADE`,
    );
    await access.invalidateTenant(tenantId);
  });

  async function seedFloodIncident(): Promise<void> {
    await authed(app, adminToken)
      .post("/v1/incidents")
      .send({
        severity: 2,
        type: "flood",
        region: "Khatlon",
        summary: "Flood emergency response near the river",
        occurredAt: "2026-06-02T08:00:00.000Z",
      })
      .expect(201);
  }

  it("merges OpenSearch documents with FTS incidents into one ranked list", async () => {
    await seedFloodIncident();
    const doc = await seedDoc("flood-report.pdf", "Annual flood report");
    cannedHits = [hit(doc, 5)];

    const res = await authed(app, adminToken)
      .get("/v1/search?q=flood")
      .expect(200);

    const byType = new Map<string, { source: string }>(
      res.body.results.map((r: { type: string; source: string }) => [
        r.type,
        r,
      ]),
    );
    expect(byType.has("incident")).toBe(true);
    expect(byType.has("document")).toBe(true);
    expect(byType.get("incident")!.source).toBe("postgres");
    expect(byType.get("document")!.source).toBe("opensearch");

    // RRF scores are positive + the merged list is non-increasing.
    const scores = res.body.results.map((r: { score: number }) => r.score);
    expect(scores.every((s: number) => s > 0)).toBe(true);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("hides a restricted-folder document from a non-grantee (gap P2.11 had)", async () => {
    const secretFolder = await mkFolder("Secret");
    await restrict(secretFolder);
    const open = await seedDoc("flood-open.pdf", "open flood report");
    const secret = await seedDoc("flood-secret.pdf", "secret flood plan", secretFolder);
    cannedHits = [hit(secret, 9), hit(open, 1)];

    const op = await authed(app, opToken).get("/v1/search?q=flood").expect(200);
    const opDocIds = op.body.results
      .filter((r: { type: string }) => r.type === "document")
      .map((r: { id: string }) => r.id);
    expect(opDocIds).toContain(open);
    expect(opDocIds).not.toContain(secret); // restricted → filtered out

    const admin = await authed(app, adminToken)
      .get("/v1/search?q=flood")
      .expect(200);
    const adminDocIds = admin.body.results
      .filter((r: { type: string }) => r.type === "document")
      .map((r: { id: string }) => r.id);
    expect(adminDocIds.sort()).toEqual([open, secret].sort()); // admin bypass
  });

  it("falls back to Postgres FTS for documents when the index is disabled", async () => {
    indexActive = false;
    cannedHits = []; // must not be consulted
    const secretFolder = await mkFolder("Secret");
    await restrict(secretFolder);
    await seedDoc("flood-open.pdf", "open flood report");
    await seedDoc("flood-secret.pdf", "secret flood plan", secretFolder);

    const op = await authed(app, opToken).get("/v1/search?q=flood").expect(200);
    const docs = op.body.results.filter(
      (r: { type: string }) => r.type === "document",
    );
    expect(docs.length).toBe(1);
    expect(docs[0].source).toBe("postgres"); // FTS fallback
    expect(docs[0].title).toBe("flood-open.pdf"); // restricted one still hidden
  });

  it("does not surface documents to a caller without document:read", async () => {
    // viewer: role-less → no read perms at all
    const viewer = await createUser(sql, tenant);
    const viewerToken = (await loginAs(app, viewer)).accessToken;
    const doc = await seedDoc("flood-report.pdf", "Annual flood report");
    cannedHits = [hit(doc, 5)];

    const res = await authed(app, viewerToken)
      .get("/v1/search?q=flood")
      .expect(200);
    expect(res.body.results).toHaveLength(0);
  });
});
