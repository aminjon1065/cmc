import { Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { TenantDatabaseService } from "../../database/tenant-database.service";
import type { OutboxService } from "../../events/outbox.service";
import type { CaseSlaActivities } from "./case-sla.types";

const OPEN_STATUSES = ["open", "triage", "in_progress"];

/**
 * Build the case-SLA activity implementations from injected services (P3.1 /
 * ADR-0045). The worker calls this once and registers the returned object as its
 * `activities`. Activities run in the API process, so they have full DB access —
 * unlike the (sandboxed) workflow. The tenant id is threaded explicitly because
 * activities run outside any request context.
 */
export function buildCaseSlaActivities(deps: {
  db: TenantDatabaseService;
  outbox: OutboxService;
}): CaseSlaActivities {
  const logger = new Logger("CaseSlaActivities");

  return {
    async loadCaseStatus(tenantId: string, caseId: string): Promise<string> {
      return deps.db.runForTenant(tenantId, async () => {
        const tx = deps.db.getCurrentTx()!;
        const rows = await tx
          .select({ status: schema.cases.status })
          .from(schema.cases)
          .where(
            and(eq(schema.cases.id, caseId), isNull(schema.cases.deletedAt)),
          )
          .limit(1);
        return rows[0]?.status ?? "missing";
      });
    },

    async escalateCase(tenantId: string, caseId: string): Promise<void> {
      // Idempotent: re-check the case is still open and not already escalated,
      // then write the activity row — all in one tenant tx.
      const didEscalate = await deps.db.runForTenant(tenantId, async () => {
        const tx = deps.db.getCurrentTx()!;
        const row = (
          await tx
            .select({ status: schema.cases.status })
            .from(schema.cases)
            .where(
              and(eq(schema.cases.id, caseId), isNull(schema.cases.deletedAt)),
            )
            .limit(1)
        )[0];
        if (!row || !OPEN_STATUSES.includes(row.status)) return false;

        const already = await tx
          .select({ id: schema.caseActivity.id })
          .from(schema.caseActivity)
          .where(
            and(
              eq(schema.caseActivity.caseId, caseId),
              eq(schema.caseActivity.kind, "sla_breached"),
            ),
          )
          .limit(1);
        if (already.length > 0) return false;

        await tx.insert(schema.caseActivity).values({
          tenantId,
          caseId,
          actorId: null, // system action
          kind: "sla_breached",
          body: null,
          metadata: { source: "sla-workflow" },
        });
        return true;
      });

      if (!didEscalate) return;

      // Emit the domain event (own privileged tx — no ambient request here) so
      // the existing notifications consumer (P2.4) can fan it out.
      await deps.outbox.publish({
        tenantId,
        aggregateType: "case",
        aggregateId: caseId,
        eventType: "sla_breached",
        payload: { caseId },
      });
      logger.log(`case ${caseId} escalated (SLA breached)`);
    },
  };
}
