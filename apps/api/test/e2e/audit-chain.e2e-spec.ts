import request from "supertest";
import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { AuditService } from "../../src/modules/audit/audit.service";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service";

/**
 * Audit-log tamper-evident hash chain (P1.11 / ADR-0029).
 *
 * Append-only is already enforced by RLS; these tests prove the DETECTION
 * layer: an async sealer links rows into a per-(tenant, day) SHA256 chain, and
 * verification recomputes it — catching a row tampered after the fact (the
 * tamper is applied with the owner connection + `app.bypass_rls`, the only way
 * past the append-only RLS, i.e. simulating a privileged/DB-level attacker).
 */
describe("Audit hash chain", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let audit: AuditService;
  let chain: AuditChainService;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;

  const today = () => new Date().toISOString().slice(0, 10);
  const genesisHash = (scope: string, day: string) =>
    createHash("sha256")
      .update(`cmc-audit-genesis:${scope}:${day}`, "utf8")
      .digest("hex");

  async function seed(tenantId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await audit.record({
        tenantId,
        actorType: "system",
        action: `test.event.${i}`,
        resourceType: "test",
        resourceId: String(i),
        outcome: "success",
      });
    }
  }

  beforeAll(async () => {
    app = await buildTestApp();
    audit = app.get(AuditService);
    chain = app.get(AuditChainService);
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "audit-tenant",
      email: "admin@audit.test",
      password: "audit_pw_123456",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, {
      email: "member@audit.test",
      password: "audit_pw_123456",
    });
    await grantSystemRole(sql, member, "operator");
  });

  // ---------- sealing + verification ----------

  it("seals pending rows and verifies a valid chain", async () => {
    await seed(tenant.id, 4);

    const sealRes = await chain.sealPendingChains();
    expect(sealRes.sealedRows).toBe(4);
    expect(sealRes.chainsTouched).toBe(1);

    const v = await chain.verifyChain(tenant.id, today());
    expect(v.valid).toBe(true);
    expect(v.sealedRows).toBe(4);
    expect(v.pendingRows).toBe(0);
    expect(v.brokenAtSeq).toBeNull();
    expect(v.tenantScope).toBe(tenant.id);
  });

  it("anchors the first row to the chain genesis and links the rest", async () => {
    await seed(tenant.id, 3);
    await chain.sealPendingChains();

    const rows = await sql<
      { prev_event_hash: string; this_hash: string; seq: string }[]
    >`SELECT prev_event_hash, this_hash, seq
        FROM audit_log WHERE tenant_id = ${tenant.id} ORDER BY seq ASC`;

    expect(rows).toHaveLength(3);
    // Row 0 is anchored to the deterministic genesis seed.
    expect(rows[0]!.prev_event_hash).toBe(genesisHash(tenant.id, today()));
    // Each subsequent row's prev is the predecessor's this_hash.
    expect(rows[1]!.prev_event_hash).toBe(rows[0]!.this_hash);
    expect(rows[2]!.prev_event_hash).toBe(rows[1]!.this_hash);
    // All hashes are distinct.
    const hashes = new Set(rows.map((r) => r.this_hash));
    expect(hashes.size).toBe(3);
  });

  it("detects a row tampered after sealing", async () => {
    await seed(tenant.id, 5);
    await chain.sealPendingChains();

    const rows = await sql<{ id: string; seq: string }[]>`
      SELECT id, seq FROM audit_log WHERE tenant_id = ${tenant.id} ORDER BY seq ASC`;
    const target = rows[2]!; // middle of the chain

    // Tamper past the append-only RLS using the owner conn + bypass flag —
    // simulating a privileged/DB-level attacker editing a row in place.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', 'on', true)`;
      await tx`update audit_log set action = 'tampered' where id = ${target.id}`;
    });

    const v = await chain.verifyChain(tenant.id, today());
    expect(v.valid).toBe(false);
    expect(v.brokenAtSeq).toBe(Number(target.seq));
  });

  it("is idempotent — re-sealing seals nothing new and preserves hashes", async () => {
    await seed(tenant.id, 3);
    await chain.sealPendingChains();
    const before = await sql<{ this_hash: string }[]>`
      SELECT this_hash FROM audit_log WHERE tenant_id = ${tenant.id} ORDER BY seq ASC`;

    const again = await chain.sealPendingChains();
    expect(again.sealedRows).toBe(0);

    const after = await sql<{ this_hash: string }[]>`
      SELECT this_hash FROM audit_log WHERE tenant_id = ${tenant.id} ORDER BY seq ASC`;
    expect(after.map((r) => r.this_hash)).toEqual(
      before.map((r) => r.this_hash),
    );
  });

  it("keeps per-tenant chains independent", async () => {
    const other = await createTenantWithAdmin(sql, {
      tenantSlug: "audit-other",
      email: "admin@auditother.test",
      password: "audit_pw_123456",
    });
    await seed(tenant.id, 2);
    await seed(other.tenant.id, 3);
    await chain.sealPendingChains();

    const v1 = await chain.verifyChain(tenant.id, today());
    const v2 = await chain.verifyChain(other.tenant.id, today());
    expect(v1.valid).toBe(true);
    expect(v1.sealedRows).toBe(2);
    expect(v2.valid).toBe(true);
    expect(v2.sealedRows).toBe(3);
  });

  // ---------- gated HTTP endpoints ----------

  it("verify endpoint: 401 anon, 403 non-admin, 200 admin", async () => {
    await seed(tenant.id, 2);
    await chain.sealPendingChains();

    await request(app.getHttpServer())
      .get("/v1/audit/chain/verify")
      .expect(401);

    const m = await loginAs(app, member);
    await authed(app, m.accessToken)
      .get("/v1/audit/chain/verify")
      .expect(403);

    const a = await loginAs(app, admin);
    const res = await authed(app, a.accessToken)
      .get("/v1/audit/chain/verify")
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.tenantScope).toBe(tenant.id);
    expect(res.body.date).toBe(today());
  });

  it("seal endpoint seals pending rows for an admin", async () => {
    await seed(tenant.id, 2);
    const a = await loginAs(app, admin);
    const res = await authed(app, a.accessToken)
      .post("/v1/audit/chain/seal")
      .expect(200);
    // The login above also wrote an audit row, so ≥ 2 get sealed.
    expect(res.body.sealedRows).toBeGreaterThanOrEqual(2);

    const v = await chain.verifyChain(tenant.id, today());
    expect(v.valid).toBe(true);
    expect(v.pendingRows).toBe(0);
  });
});
