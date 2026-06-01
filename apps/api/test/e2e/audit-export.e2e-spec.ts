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
import { AuditExportService } from "../../src/modules/audit/audit-export.service";
import {
  AUDIT_EXPORT_SINK,
  type AuditExportSink,
} from "../../src/modules/audit/audit-export.sink";
import {
  formatCef,
  formatRfc5424,
  type AuditRow,
} from "../../src/modules/audit/audit-export.formatters";

function fixtureRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    actorId: "33333333-3333-4333-8333-333333333333",
    actorType: "user",
    action: "user.login",
    resourceType: "session",
    resourceId: "sess-1",
    outcome: "success",
    ip: "10.0.0.5",
    userAgent: "jest",
    requestId: "req-abc",
    traceId: "trace-xyz",
    metadata: { foo: "bar" },
    prevEventHash: null,
    thisHash: null,
    seq: 42,
    sealedAt: null,
    occurredAt: new Date("2026-06-01T12:00:00.000Z"),
    ...overrides,
  };
}

/**
 * SIEM audit export (P1.12 / ADR-0030). Formatter output is asserted directly;
 * the worker is exercised with a capturing fake sink (no file/TCP in jest).
 */
describe("Audit SIEM export", () => {
  // ---------- formatters (pure) ----------

  describe("formatters", () => {
    it("RFC 5424: PRI/version/host/app/msgid + structured data + msg", () => {
      const line = formatRfc5424(fixtureRow(), "cmc-host");
      // facility 13 (log audit) * 8 + severity 6 (info) = 110
      expect(line.startsWith("<110>1 2026-06-01T12:00:00.000Z cmc-host cmc-audit - user.login ")).toBe(true);
      expect(line).toContain('[cmc@99999 ');
      expect(line).toContain('eid="11111111-1111-4111-8111-111111111111"');
      expect(line).toContain('seq="42"');
      expect(line).toContain('outcome="success"');
      expect(line).toContain('src="10.0.0.5"');
      expect(line).toContain('traceId="trace-xyz"');
      expect(line).toContain("-> success");
    });

    it("RFC 5424 severities track the outcome", () => {
      expect(formatRfc5424(fixtureRow({ outcome: "failure" }), "h").startsWith("<108>")).toBe(true);
      expect(formatRfc5424(fixtureRow({ outcome: "denied" }), "h").startsWith("<109>")).toBe(true);
    });

    it("CEF: header + extension keys", () => {
      const line = formatCef(fixtureRow());
      expect(line.startsWith("CEF:0|CMC|Platform|1.0|user.login|user.login|3|")).toBe(true);
      expect(line).toContain("deviceExternalId=11111111-1111-4111-8111-111111111111");
      expect(line).toContain("suser=user");
      expect(line).toContain("act=user.login");
      expect(line).toContain("outcome=success");
      expect(line).toContain("src=10.0.0.5");
      expect(line).toContain("cn1=42");
      expect(line).toContain("cs1=trace-xyz");
    });

    it("escapes format-special characters", () => {
      const rfc = formatRfc5424(
        fixtureRow({ resourceId: 'a]b"c' }),
        "h",
      );
      expect(rfc).toContain('resourceId="a\\]b\\"c"');

      const cef = formatCef(fixtureRow({ action: "a|b" }));
      // header pipe escaped
      expect(cef.startsWith("CEF:0|CMC|Platform|1.0|a\\|b|a\\|b|3|")).toBe(true);
    });
  });

  // ---------- worker ----------

  describe("worker", () => {
    let app: INestApplication;
    let sql: ReturnType<typeof ownerSql>;
    let redis: Redis;
    let audit: AuditService;
    let exporter: AuditExportService;
    let tenant: TestTenant;
    let admin: TestUser;
    let member: TestUser;
    const captured: string[] = [];

    const fakeSink: AuditExportSink = {
      transport: "fake",
      write: async (lines) => {
        captured.push(...lines);
      },
    };

    async function seed(tenantId: string, n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await audit.record({
          tenantId,
          actorType: "system",
          action: `export.event.${i}`,
          resourceType: "test",
          outcome: "success",
        });
      }
    }

    beforeAll(async () => {
      app = await buildTestApp((b) =>
        b.overrideProvider(AUDIT_EXPORT_SINK).useValue(fakeSink),
      );
      audit = app.get(AuditService);
      exporter = app.get(AuditExportService);
      sql = ownerSql();
      redis = app.get<Redis>(REDIS);
    });

    afterAll(async () => {
      await app.close();
      await sql.end({ timeout: 2 });
    });

    beforeEach(async () => {
      captured.length = 0;
      await truncateAll(sql, redis);
      const fixture = await createTenantWithAdmin(sql, {
        tenantSlug: "export-tenant",
        email: "admin@export.test",
        password: "export_pw_1234",
      });
      tenant = fixture.tenant;
      admin = fixture.user;
      member = await createUser(sql, tenant, {
        email: "member@export.test",
        password: "export_pw_1234",
      });
      await grantSystemRole(sql, member, "operator");
    });

    it("flushes pending rows to the sink and advances the cursor", async () => {
      await seed(tenant.id, 3);
      const res = await exporter.flush();
      expect(res.exported).toBe(3);
      expect(res.cursorSeq).toBeGreaterThan(0);
      expect(captured).toHaveLength(3);
      // default format is rfc5424
      expect(captured.every((l) => l.startsWith("<"))).toBe(true);
    });

    it("re-flushing exports nothing once the cursor is at the head", async () => {
      await seed(tenant.id, 2);
      await exporter.flush();
      const again = await exporter.flush();
      expect(again.exported).toBe(0);
      expect(captured).toHaveLength(2);
    });

    it("exports only rows added since the last flush", async () => {
      await seed(tenant.id, 2);
      await exporter.flush();
      captured.length = 0;
      await seed(tenant.id, 3);
      const res = await exporter.flush();
      expect(res.exported).toBe(3);
      expect(captured).toHaveLength(3);
    });

    it("status reports cursor + pending", async () => {
      await seed(tenant.id, 4);
      const before = await exporter.status();
      expect(before.enabled).toBe(false); // interval off by default
      expect(before.format).toBe("rfc5424");
      expect(before.cursorSeq).toBe(0);
      expect(before.pending).toBe(4);

      await exporter.flush();
      const after = await exporter.status();
      expect(after.pending).toBe(0);
      expect(after.cursorSeq).toBeGreaterThan(0);
      expect(after.updatedAt).not.toBeNull();
    });

    it("export endpoints: 401 anon, 403 non-admin, 200 admin", async () => {
      await seed(tenant.id, 2);

      await request(app.getHttpServer())
        .get("/v1/audit/export/status")
        .expect(401);

      const m = await loginAs(app, member);
      await authed(app, m.accessToken)
        .post("/v1/audit/export/flush")
        .expect(403);

      const a = await loginAs(app, admin);
      const statusRes = await authed(app, a.accessToken)
        .get("/v1/audit/export/status")
        .expect(200);
      expect(typeof statusRes.body.cursorSeq).toBe("number");

      const flushRes = await authed(app, a.accessToken)
        .post("/v1/audit/export/flush")
        .expect(200);
      expect(flushRes.body.exported).toBeGreaterThanOrEqual(2);
    });
  });
});
