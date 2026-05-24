import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  ListDocumentsResponseSchema,
  SessionsListResponseSchema,
} from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { authed, loginAs } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * The most security-critical guarantee in the platform: a request from
 * Tenant A must never observe or mutate a row that belongs to Tenant B,
 * regardless of what id the request guesses.
 *
 * These tests exercise that at the API layer with two distinct tenants
 * each holding their own session and (in one case) document. They are
 * the canonical regression for the bug discovered in ADR-0004 (cmc role
 * was a superuser; RLS policies silently bypassed).
 */
describe("RLS — cross-tenant isolation", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let userA: TestUser;
  let userB: TestUser;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    const a = await createTenantWithAdmin(sql, {
      tenantSlug: "tenant-a",
      email: "alice@a.test",
    });
    const b = await createTenantWithAdmin(sql, {
      tenantSlug: "tenant-b",
      email: "bob@b.test",
    });
    tenantA = a.tenant;
    tenantB = b.tenant;
    userA = a.user;
    userB = b.user;
  });

  // ---------- sessions ----------

  describe("sessions", () => {
    it("Tenant A's GET /auth/sessions only returns A's rows", async () => {
      const aLogin = await loginAs(app, userA);
      await loginAs(app, userB); // creates a session for Tenant B

      const res = await authed(app, aLogin.accessToken)
        .get("/auth/sessions")
        .expect(200);

      const list = SessionsListResponseSchema.parse(res.body);
      expect(list.sessions.length).toBe(1);
      expect(list.sessions[0]?.id).toBeDefined();

      // Total active sessions in DB across both tenants is 2.
      const total = await sql<{ c: number }[]>`
        SELECT count(*)::int AS c FROM sessions WHERE revoked_at IS NULL
      `;
      expect(total[0]?.c).toBe(2);
    });

    it("Tenant A cannot revoke Tenant B's session — returns 404", async () => {
      const aLogin = await loginAs(app, userA);
      await loginAs(app, userB);

      const bSession = await sql<{ id: string }[]>`
        SELECT id FROM sessions
        WHERE tenant_id = ${tenantB.id} AND revoked_at IS NULL
        LIMIT 1
      `;
      expect(bSession.length).toBe(1);

      await authed(app, aLogin.accessToken)
        .delete(`/auth/sessions/${bSession[0]!.id}`)
        .expect(404);

      // B's session is unchanged.
      const after = await sql<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM sessions WHERE id = ${bSession[0]!.id}
      `;
      expect(after[0]?.revoked_at).toBeNull();
    });
  });

  // ---------- documents ----------

  describe("documents", () => {
    it("Tenant A's GET /documents excludes Tenant B's documents", async () => {
      // Pre-create a document for Tenant B directly.
      await sql`SET app.bypass_rls = 'on'`;
      await sql`
        INSERT INTO documents (
          tenant_id, name, mime_type, size_bytes, storage_bucket,
          storage_key, status, uploaded_by
        ) VALUES (
          ${tenantB.id}, 'b-secret.txt', 'text/plain', 100, 'cmc-files',
          ${`tenants/${tenantB.id}/documents/fake-b`}, 'ready', ${userB.id}
        )
      `;
      await sql`RESET app.bypass_rls`;

      const aLogin = await loginAs(app, userA);
      const res = await authed(app, aLogin.accessToken)
        .get("/documents")
        .expect(200);
      const list = ListDocumentsResponseSchema.parse(res.body);
      expect(list.total).toBe(0);
      expect(list.documents).toEqual([]);
    });

    it("Tenant A cannot GET, download, or DELETE Tenant B's document", async () => {
      await sql`SET app.bypass_rls = 'on'`;
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO documents (
          tenant_id, name, mime_type, size_bytes, storage_bucket,
          storage_key, status, uploaded_by
        ) VALUES (
          ${tenantB.id}, 'b-secret.txt', 'text/plain', 100, 'cmc-files',
          ${`tenants/${tenantB.id}/documents/fake-b-2`}, 'ready', ${userB.id}
        ) RETURNING id
      `;
      await sql`RESET app.bypass_rls`;
      const docId = inserted[0]!.id;

      const aLogin = await loginAs(app, userA);

      await authed(app, aLogin.accessToken)
        .get(`/documents/${docId}`)
        .expect(404);

      await authed(app, aLogin.accessToken)
        .get(`/documents/${docId}/download-url`)
        .expect(404);

      await authed(app, aLogin.accessToken)
        .delete(`/documents/${docId}`)
        .expect(404);

      // Row is intact in DB.
      await sql`SET app.bypass_rls = 'on'`;
      const after = await sql<{ deleted_at: Date | null }[]>`
        SELECT deleted_at FROM documents WHERE id = ${docId}
      `;
      await sql`RESET app.bypass_rls`;
      expect(after[0]?.deleted_at).toBeNull();
    });
  });

  // ---------- Postgres-level invariant ----------

  describe("DB-level role guarantees", () => {
    it("the runtime role (cmc_app) is non-superuser AND non-bypassrls", async () => {
      const role = await sql<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'cmc_app'`;
      expect(role.length).toBe(1);
      expect(role[0]?.rolsuper).toBe(false);
      expect(role[0]?.rolbypassrls).toBe(false);
    });

    it("every tenant-scoped table has FORCE ROW LEVEL SECURITY", async () => {
      const tables = await sql<
        {
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }[]
      >`SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname IN ('users', 'sessions', 'audit_log', 'documents')`;
      expect(tables.length).toBe(4);
      for (const t of tables) {
        expect(t.relrowsecurity).toBe(true);
        expect(t.relforcerowsecurity).toBe(true);
      }
    });
  });
});
