import request from "supertest";
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
import { StorageService } from "../../src/modules/storage/storage.service";

/**
 * Daily Merkle anchoring of the audit hash chain (P1.11b / ADR-0029).
 *
 * StorageService is replaced with a fake so the suite never touches MinIO: the
 * aws-sdk `PutObject` path lazy-imports under jest's VM-modules runtime, and
 * the WORM write is validated in the live smoke instead. These tests cover the
 * Merkle math, the anchor record, idempotency, and the verify-against-anchor
 * cross-check.
 */
type ImmutablePut = {
  bucket: string;
  key: string;
  body: string;
  lockMode: "GOVERNANCE" | "COMPLIANCE";
  retainUntil: Date;
};

describe("Audit Merkle anchoring", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let audit: AuditService;
  let chain: AuditChainService;
  let tenant: TestTenant;
  let admin: TestUser;
  let member: TestUser;
  const puts: ImmutablePut[] = [];

  const today = () => new Date().toISOString().slice(0, 10);

  async function seed(tenantId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await audit.record({
        tenantId,
        actorType: "system",
        action: `anchor.event.${i}`,
        resourceType: "test",
        outcome: "success",
      });
    }
  }

  const fakeStorage = {
    putImmutableObject: async (input: ImmutablePut) => {
      puts.push(input);
      return { versionId: `ver-${puts.length}` };
    },
  } as unknown as StorageService;

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(StorageService).useValue(fakeStorage),
    );
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
    puts.length = 0;
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "anchor-tenant",
      email: "admin@anchor.test",
      password: "anchor_pw_12345",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    member = await createUser(sql, tenant, {
      email: "member@anchor.test",
      password: "anchor_pw_12345",
    });
    await grantSystemRole(sql, member, "operator");
  });

  it("anchors a sealed chain: writes a locked object and records the anchor", async () => {
    await seed(tenant.id, 3);
    await chain.sealPendingChains();

    const res = await chain.anchorChain(tenant.id, today());
    expect(res).not.toBeNull();
    expect(res!.alreadyAnchored).toBe(false);
    expect(res!.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(res!.rowCount).toBe(3);
    expect(res!.objectKey).toBe(`anchors/${tenant.id}/${today()}.json`);
    expect(res!.objectVersionId).toBe("ver-1");

    // The WORM object was written with a future retention + the configured mode.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.bucket).toBe("cmc-audit-anchors");
    expect(puts[0]!.lockMode).toBe("GOVERNANCE");
    expect(puts[0]!.retainUntil.getTime()).toBeGreaterThan(Date.now());

    const anchorRows = await sql<{ merkle_root: string }[]>`
      SELECT merkle_root FROM audit_chain_anchor WHERE tenant_scope = ${tenant.id}`;
    expect(anchorRows).toHaveLength(1);
    expect(anchorRows[0]!.merkle_root).toBe(res!.merkleRoot);
  });

  it("verify reports anchored + rootMatches once anchored, anchored:false before", async () => {
    await seed(tenant.id, 3);
    await chain.sealPendingChains();

    const before = await chain.verifyChain(tenant.id, today());
    expect(before.anchored).toBe(false);
    expect(before.anchorRoot).toBeNull();
    expect(before.rootMatches).toBeNull();

    const anchor = await chain.anchorChain(tenant.id, today());
    const after = await chain.verifyChain(tenant.id, today());
    expect(after.anchored).toBe(true);
    expect(after.anchorRoot).toBe(anchor!.merkleRoot);
    expect(after.rootMatches).toBe(true);
  });

  it("re-anchoring the same chain is idempotent (no second object)", async () => {
    await seed(tenant.id, 2);
    await chain.sealPendingChains();

    const first = await chain.anchorChain(tenant.id, today());
    expect(first!.alreadyAnchored).toBe(false);
    expect(puts).toHaveLength(1);

    const second = await chain.anchorChain(tenant.id, today());
    expect(second!.alreadyAnchored).toBe(true);
    expect(second!.merkleRoot).toBe(first!.merkleRoot);
    expect(puts).toHaveLength(1); // no new WORM write
  });

  it("rootMatches goes false when a sealed hash is altered after anchoring", async () => {
    await seed(tenant.id, 4);
    await chain.sealPendingChains();
    await chain.anchorChain(tenant.id, today());

    const [target] = await sql<{ id: string }[]>`
      SELECT id FROM audit_log WHERE tenant_id = ${tenant.id}
       ORDER BY seq ASC OFFSET 1 LIMIT 1`;
    await sql.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', 'on', true)`;
      await tx`update audit_log set this_hash = repeat('0', 64) where id = ${target!.id}`;
    });

    const v = await chain.verifyChain(tenant.id, today());
    expect(v.anchored).toBe(true);
    expect(v.rootMatches).toBe(false); // the immutable anchor no longer matches
    expect(v.valid).toBe(false); // the per-row chain also breaks
  });

  it("does not anchor a chain that still has pending (unsealed) rows", async () => {
    await seed(tenant.id, 2);
    // no seal → rows are pending
    const res = await chain.anchorChain(tenant.id, today());
    expect(res).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("anchor status surfaces a past sealed-but-unanchored day as a gap (P3.15)", async () => {
    // A row dated yesterday → its own (tenant, day) chain.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await sql.begin(async (tx) => {
      await tx`select set_config('app.bypass_rls', 'on', true)`;
      await tx`INSERT INTO audit_log (tenant_id, actor_type, action, resource_type, outcome, occurred_at)
               VALUES (${tenant.id}, 'system', 'past.event', 'test', 'success', now() - make_interval(days => 1))`;
    });
    await chain.sealPendingChains();

    const before = await chain.anchorStatus(tenant.id, 7);
    const ydByDate = before.days.find((d) => d.date === yesterday);
    expect(ydByDate?.sealedRows).toBe(1);
    expect(ydByDate?.anchored).toBe(false);
    expect(before.gaps).toContain(yesterday); // dropped-day evidence

    // Anchoring it clears the gap.
    await chain.anchorChain(tenant.id, yesterday);
    const after = await chain.anchorStatus(tenant.id, 7);
    expect(after.gaps).not.toContain(yesterday);
    expect(after.days.find((d) => d.date === yesterday)?.anchored).toBe(true);
  });

  it("concurrent anchoring writes the WORM object exactly once (HA advisory lock, P3.15)", async () => {
    await seed(tenant.id, 3);
    await chain.sealPendingChains();

    const [a, b] = await Promise.all([
      chain.anchorChain(tenant.id, today()),
      chain.anchorChain(tenant.id, today()),
    ]);
    // Exactly one created it; the other observed the existing anchor.
    expect([a!.alreadyAnchored, b!.alreadyAnchored].sort()).toEqual([false, true]);
    expect(a!.merkleRoot).toBe(b!.merkleRoot);
    expect(puts).toHaveLength(1); // single WORM write despite the race

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_chain_anchor WHERE tenant_scope = ${tenant.id}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("anchor/status endpoint: 403 non-admin, 200 admin (P3.15)", async () => {
    await seed(tenant.id, 2);
    await chain.sealPendingChains();
    const m = await loginAs(app, member);
    await authed(app, m.accessToken)
      .get("/v1/audit/anchor/status?days=7")
      .expect(403);
    const a = await loginAs(app, admin);
    const res = await authed(app, a.accessToken)
      .get("/v1/audit/anchor/status?days=7")
      .expect(200);
    expect(res.body.tenantScope).toBe(tenant.id);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(Array.isArray(res.body.gaps)).toBe(true);
  });

  it("anchor endpoint: 401 anon, 403 non-admin, 200 admin", async () => {
    await seed(tenant.id, 2);

    await request(app.getHttpServer())
      .post("/v1/audit/chain/anchor")
      .expect(401);

    const m = await loginAs(app, member);
    await authed(app, m.accessToken)
      .post("/v1/audit/chain/anchor")
      .expect(403);

    const a = await loginAs(app, admin);
    const res = await authed(app, a.accessToken)
      .post("/v1/audit/chain/anchor")
      .expect(200);
    expect(res.body.tenantScope).toBe(tenant.id);
    expect(res.body.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.alreadyAnchored).toBe(false);
  });
});
