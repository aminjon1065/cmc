import { Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { TenantDatabaseService } from "../../database/tenant-database.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { WorkflowInterpreterActivities } from "./workflow-interpreter.types";

/**
 * Interpreter activity implementations (P3.8b / ADR-0053), built from injected
 * services by the worker. They run in the API process (full DB access), unlike
 * the sandboxed interpreter workflow. Tenant id is threaded explicitly (no
 * request context) and queries go through `runForTenant` (RLS-scoped).
 */
export function buildWorkflowInterpreterActivities(deps: {
  db: TenantDatabaseService;
  notifications: NotificationsService;
}): WorkflowInterpreterActivities {
  const logger = new Logger("WorkflowInterpreterActivities");

  return {
    async markRunStatus(tenantId, runId, status, extra): Promise<void> {
      await deps.db.runForTenant(tenantId, async () => {
        const tx = deps.db.getCurrentTx()!;
        await tx
          .update(schema.workflowRuns)
          .set({
            status,
            ...(extra?.output !== undefined ? { output: extra.output } : {}),
            ...(extra?.error !== undefined ? { error: extra.error } : {}),
            ...(status === "completed" || status === "failed"
              ? { finishedAt: sql`now()` }
              : {}),
          })
          .where(eq(schema.workflowRuns.id, runId));
      });
    },

    async executeNotify(tenantId, runId, cfg, fallbackUserId): Promise<void> {
      const recipient = cfg.toUserId ?? fallbackUserId;
      if (!recipient) {
        logger.warn(`notify node skipped (no recipient) for run ${runId}`);
        return;
      }
      await deps.notifications.notifyUsers(tenantId, [recipient], {
        kind: "workflow.notify",
        title: cfg.title,
        body: cfg.body,
      });
    },

    async executeCreateIncident(tenantId, cfg, startedBy): Promise<string> {
      return deps.db.runForTenant(tenantId, async () => {
        const tx = deps.db.getCurrentTx()!;
        const [row] = await tx
          .insert(schema.incidents)
          .values({
            tenantId,
            severity: cfg.severity,
            status: "reported",
            type: cfg.type,
            region: cfg.region,
            summary: cfg.summary,
            occurredAt: new Date(),
            reportedBy: startedBy,
          })
          .returning({ id: schema.incidents.id });
        logger.log(`workflow created incident ${row!.id}`);
        return row!.id;
      });
    },
  };
}
