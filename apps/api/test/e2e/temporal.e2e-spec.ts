import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import {
  TEMPORAL_CLIENT,
  NoopTemporalClient,
  createTemporalClient,
  type StartWorkflowInput,
  type TemporalClient,
} from "../../src/modules/temporal/temporal-client";
import { CaseSlaScheduler } from "../../src/modules/temporal/case-sla.scheduler";
import { IncidentResponseScheduler } from "../../src/modules/temporal/incident-response.scheduler";
import { RbacService } from "../../src/modules/rbac/rbac.service";
import { TenantDatabaseService } from "../../src/modules/database/tenant-database.service";

/**
 * Temporal seam + case-SLA lifecycle wiring (P3.1 / ADR-0045). The client is
 * faked (capturing), so both the scheduler's translation AND the CasesService
 * lifecycle (create/update/transition → schedule/cancel) are observable without
 * a running Temporal. Workflow EXECUTION (worker runs the durable timer) is
 * covered by the live smoke.
 */
describe("Temporal seam", () => {
  describe("client factory / noop (gating)", () => {
    it("NoopTemporalClient is inert", async () => {
      const noop: TemporalClient = new NoopTemporalClient();
      expect(noop.active).toBe(false);
      await expect(
        noop.start({ workflowType: "x", workflowId: "y", args: [] }),
      ).resolves.toBeUndefined();
      await expect(noop.cancel("y")).resolves.toBeUndefined();
    });

    it("createTemporalClient returns a Noop when TEMPORAL_ENABLED is false", async () => {
      const fakeConfig = { get: () => false } as unknown as Parameters<
        typeof createTemporalClient
      >[0];
      const client = await createTemporalClient(fakeConfig);
      expect(client.active).toBe(false);
      expect(client).toBeInstanceOf(NoopTemporalClient);
    });
  });

  describe("with a faked client", () => {
    let app: INestApplication;
    let sql: ReturnType<typeof ownerSql>;
    let redis: Redis;
    let token: string;
    let tenantId: string;
    let adminId: string;
    const started: StartWorkflowInput[] = [];
    const cancelled: string[] = [];

    const fakeClient: TemporalClient = {
      active: true,
      async start(input) {
        started.push(input);
      },
      async cancel(workflowId) {
        cancelled.push(workflowId);
      },
      async close() {},
    };

    beforeAll(async () => {
      app = await buildTestApp((b) =>
        b.overrideProvider(TEMPORAL_CLIENT).useValue(fakeClient),
      );
      sql = ownerSql();
      redis = app.get<Redis>(REDIS);
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
      started.length = 0;
      cancelled.length = 0;
      await sql.unsafe(
        `TRUNCATE case_activity, cases, incidents RESTART IDENTITY CASCADE`,
      );
    });

    // ---------- direct scheduler → client ----------

    it("schedule() starts caseSlaWorkflow with a deterministic id + args", async () => {
      const scheduler = app.get(CaseSlaScheduler);
      const due = "2030-01-01T00:00:00.000Z";
      await scheduler.schedule("tenant-1", "case-1", due);
      expect(started).toEqual([
        {
          workflowType: "caseSlaWorkflow",
          workflowId: "case-sla:case-1",
          args: [{ tenantId: "tenant-1", caseId: "case-1", dueAtIso: due }],
        },
      ]);
    });

    it("cancel() cancels by the same deterministic workflow id", async () => {
      const scheduler = app.get(CaseSlaScheduler);
      await scheduler.cancel("case-1");
      expect(cancelled).toEqual(["case-sla:case-1"]);
    });

    it("workflow id is one-per-case (idempotent start key)", () => {
      expect(CaseSlaScheduler.workflowId("abc")).toBe("case-sla:abc");
    });

    // ---------- CasesService lifecycle → scheduler ----------

    const due = "2031-06-01T00:00:00.000Z";
    const mkCase = async (body: Record<string, unknown>): Promise<string> => {
      const res = await authed(app, token)
        .post("/v1/cases")
        .send({ title: "SLA case", type: "investigation", ...body });
      expect(res.status).toBe(201);
      return res.body.case.id as string;
    };

    it("create with a due date schedules the SLA timer", async () => {
      const id = await mkCase({ dueAt: due });
      expect(started).toEqual([
        {
          workflowType: "caseSlaWorkflow",
          workflowId: `case-sla:${id}`,
          args: [{ tenantId, caseId: id, dueAtIso: due }],
        },
      ]);
      expect(cancelled).toEqual([]);
    });

    it("create without a due date schedules nothing", async () => {
      await mkCase({});
      expect(started).toEqual([]);
    });

    it("transition to a terminal state cancels the timer", async () => {
      const id = await mkCase({ dueAt: due });
      started.length = 0;
      const res = await authed(app, token)
        .post(`/v1/cases/${id}/transition`)
        .send({ to: "cancelled" });
      expect(res.status).toBe(200);
      expect(cancelled).toEqual([`case-sla:${id}`]);
    });

    it("update sets/clears the SLA timer when due_at changes", async () => {
      const id = await mkCase({}); // no timer yet
      expect(started).toEqual([]);

      await authed(app, token).patch(`/v1/cases/${id}`).send({ dueAt: due });
      expect(started).toEqual([
        {
          workflowType: "caseSlaWorkflow",
          workflowId: `case-sla:${id}`,
          args: [{ tenantId, caseId: id, dueAtIso: due }],
        },
      ]);

      await authed(app, token).patch(`/v1/cases/${id}`).send({ dueAt: null });
      expect(cancelled).toEqual([`case-sla:${id}`]);
    });

    // ---------- incident-response scheduler → client ----------

    it("onCreated starts the response workflow for a severe incident", async () => {
      const scheduler = app.get(IncidentResponseScheduler);
      await scheduler.onCreated(tenantId, "inc-1", 1); // SEV-1
      expect(started).toHaveLength(1);
      const call = started[0]!;
      expect(call.workflowType).toBe("incidentResponseWorkflow");
      expect(call.workflowId).toBe("incident-response:inc-1");
      const arg = call.args[0] as Record<string, unknown>;
      expect(arg.tenantId).toBe(tenantId);
      expect(arg.incidentId).toBe("inc-1");
      expect(typeof arg.ackSlaSec).toBe("number");
      expect(typeof arg.reminderIntervalSec).toBe("number");
    });

    it("onCreated does nothing for a low-severity incident (default threshold 2)", async () => {
      const scheduler = app.get(IncidentResponseScheduler);
      await scheduler.onCreated(tenantId, "inc-2", 4); // SEV-4 → below threshold
      expect(started).toEqual([]);
      expect(scheduler.isSevere(2)).toBe(true);
      expect(scheduler.isSevere(3)).toBe(false);
    });

    it("cancel cancels by the deterministic incident workflow id", async () => {
      const scheduler = app.get(IncidentResponseScheduler);
      await scheduler.cancel("inc-1");
      expect(cancelled).toEqual(["incident-response:inc-1"]);
    });

    // ---------- RBAC reverse lookup (escalation recipients) ----------

    it("usersWithPermission finds incident:resolve holders in the tenant", async () => {
      const rbac = app.get(RbacService);
      const db = app.get(TenantDatabaseService);
      const resolvers = await db.runForTenant(tenantId, () =>
        rbac.usersWithPermission("incident", "resolve"),
      );
      expect(resolvers).toContain(adminId); // the seeded admin holds incident:resolve
    });

    // ---------- IncidentsService lifecycle → scheduler ----------

    const mkIncident = async (severity: number): Promise<string> => {
      const res = await authed(app, token).post("/v1/incidents").send({
        severity,
        type: "Flood",
        region: "Khatlon",
        summary: "Vakhsh river breach",
        occurredAt: "2026-06-02T00:00:00.000Z",
      });
      expect(res.status).toBe(201);
      return res.body.incident.id as string;
    };

    it("a severe incident starts the response workflow on create", async () => {
      const id = await mkIncident(1); // SEV-1
      expect(started).toHaveLength(1);
      expect(started[0]!.workflowId).toBe(`incident-response:${id}`);
      expect(started[0]!.workflowType).toBe("incidentResponseWorkflow");
    });

    it("a low-severity incident starts nothing on create", async () => {
      await mkIncident(4); // SEV-4 → below threshold
      expect(started).toEqual([]);
    });

    it("resolving/cancelling a severe incident cancels the workflow", async () => {
      const id = await mkIncident(1);
      started.length = 0;
      const res = await authed(app, token)
        .post(`/v1/incidents/${id}/transition`)
        .send({ to: "cancelled" }); // terminal, needs only incident:write
      expect(res.status).toBe(200);
      expect(cancelled).toEqual([`incident-response:${id}`]);
    });
  });
});
