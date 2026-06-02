import type { INestApplication } from "@nestjs/common";
import { buildTestApp } from "../helpers/test-app";
import {
  TEMPORAL_CLIENT,
  NoopTemporalClient,
  createTemporalClient,
  type StartWorkflowInput,
  type TemporalClient,
} from "../../src/modules/temporal/temporal-client";
import { CaseSlaScheduler } from "../../src/modules/temporal/case-sla.scheduler";

/**
 * Temporal seam (P3.1 / ADR-0045). The client is faked (capturing), so the
 * scheduler's translation of case lifecycle → workflow ops is observable without
 * a running Temporal. Workflow EXECUTION (worker runs the durable timer →
 * escalation) is covered by the live smoke. Gating: with Temporal off (the test
 * default) the factory yields a Noop client and the worker never starts.
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

  describe("CaseSlaScheduler → client", () => {
    let app: INestApplication;
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
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      started.length = 0;
      cancelled.length = 0;
    });

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
  });
});
