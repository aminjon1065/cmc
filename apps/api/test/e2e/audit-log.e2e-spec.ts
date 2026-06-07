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

/**
 * Audit log viewer — `GET /v1/audit/log` (read-only, gated `audit:read`).
 *
 * Proves: the `auditor` role can read; a role without `audit:read` (operator)
 * is 403; action filter; keyset pagination (`limit` + `before`); and RLS
 * tenant isolation (one tenant never sees another's audit rows).
 */
describe("Audit log viewer (GET /v1/audit/log)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let audit: AuditService;
  let tenant: TestTenant;
  let auditor: TestUser;
  let operator: TestUser;

  async function seed(
    tenantId: string,
    n: number,
    action = "test.event",
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      await audit.record({
        tenantId,
        actorType: "system",
        action: `${action}.${i}`,
        resourceType: "test",
        resourceId: String(i),
        outcome: "success",
      });
    }
  }

  beforeAll(async () => {
    app = await buildTestApp();
    audit = app.get(AuditService);
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
      tenantSlug: "audit-log-tenant",
      email: "admin@auditlog.test",
      password: "audit_pw_123456",
    });
    tenant = fixture.tenant;
    auditor = await createUser(sql, tenant, {
      email: "auditor@auditlog.test",
      password: "audit_pw_123456",
    });
    await grantSystemRole(sql, auditor, "auditor");
    operator = await createUser(sql, tenant, {
      email: "operator@auditlog.test",
      password: "audit_pw_123456",
    });
    await grantSystemRole(sql, operator, "operator");
  });

  it("returns rows newest-first for an auditor (audit:read)", async () => {
    await seed(tenant.id, 3);
    const a = await loginAs(app, auditor);
    const res = await authed(app, a.accessToken)
      .get("/v1/audit/log")
      .expect(200);

    expect(Array.isArray(res.body.entries)).toBe(true);
    const seqs = res.body.entries.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x)); // desc
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["test.event.0", "test.event.2"]),
    );
    // Safe subset: no raw chain hashes leaked.
    expect(res.body.entries[0]).not.toHaveProperty("thisHash");
    expect(res.body.entries[0]).toHaveProperty("sealed");
  });

  it("403s for a user without audit:read (operator)", async () => {
    const o = await loginAs(app, operator);
    await authed(app, o.accessToken).get("/v1/audit/log").expect(403);
  });

  it("filters by action", async () => {
    await seed(tenant.id, 2, "alpha");
    await seed(tenant.id, 2, "beta");
    const a = await loginAs(app, auditor);
    const res = await authed(app, a.accessToken)
      .get("/v1/audit/log?action=alpha.0")
      .expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].action).toBe("alpha.0");
  });

  it("paginates with limit + before cursor (no overlap)", async () => {
    await seed(tenant.id, 5, "pg");
    const a = await loginAs(app, auditor);
    const p1 = await authed(app, a.accessToken)
      .get("/v1/audit/log?limit=2")
      .expect(200);
    expect(p1.body.entries).toHaveLength(2);
    expect(p1.body.nextCursor).toBeGreaterThan(0);

    const p2 = await authed(app, a.accessToken)
      .get(`/v1/audit/log?limit=2&before=${p1.body.nextCursor}`)
      .expect(200);
    expect(p2.body.entries).toHaveLength(2);

    const minP1 = Math.min(...p1.body.entries.map((e: { seq: number }) => e.seq));
    const maxP2 = Math.max(...p2.body.entries.map((e: { seq: number }) => e.seq));
    expect(maxP2).toBeLessThan(minP1);
  });

  it("is tenant-isolated (RLS) — never another tenant's rows", async () => {
    await seed(tenant.id, 2, "mine");
    const other = await createTenantWithAdmin(sql, {
      tenantSlug: "other-audit-tenant",
      email: "admin@other-audit.test",
      password: "audit_pw_123456",
    });
    await seed(other.tenant.id, 3, "theirs");

    const a = await loginAs(app, auditor);
    const res = await authed(app, a.accessToken)
      .get("/v1/audit/log?limit=200")
      .expect(200);
    const actions: string[] = res.body.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(actions.some((x) => x.startsWith("theirs"))).toBe(false);
    expect(actions.some((x) => x.startsWith("mine"))).toBe(true);
  });
});
