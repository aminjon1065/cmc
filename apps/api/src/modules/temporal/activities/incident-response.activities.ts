import { Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { TenantDatabaseService } from "../../database/tenant-database.service";
import type { OutboxService } from "../../events/outbox.service";
import type { NotificationsService } from "../../notifications/notifications.service";
import type { RbacService } from "../../rbac/rbac.service";
import type {
  IncidentResponseActivities,
  ResponsePhase,
} from "./incident-response.types";

const UNACKNOWLEDGED = "reported";

/**
 * Incident-response activity implementations (P3.2 / ADR-0046), built from
 * injected services by the worker. Run in the API process (full DB access),
 * unlike the sandboxed workflow. Tenant id is threaded explicitly (no request).
 */
export function buildIncidentResponseActivities(deps: {
  db: TenantDatabaseService;
  outbox: OutboxService;
  notifications: NotificationsService;
  rbac: RbacService;
}): IncidentResponseActivities {
  const logger = new Logger("IncidentResponseActivities");

  const loadIncident = (tenantId: string, incidentId: string) =>
    deps.db.runForTenant(tenantId, async () => {
      const tx = deps.db.getCurrentTx()!;
      const row = (
        await tx
          .select({
            status: schema.incidents.status,
            summary: schema.incidents.summary,
            severity: schema.incidents.severity,
            region: schema.incidents.region,
            type: schema.incidents.type,
            assignedTo: schema.incidents.assignedTo,
            reportedBy: schema.incidents.reportedBy,
          })
          .from(schema.incidents)
          .where(
            and(
              eq(schema.incidents.id, incidentId),
              isNull(schema.incidents.deletedAt),
            ),
          )
          .limit(1)
      )[0];
      return row ?? null;
    });

  return {
    async loadIncidentStatus(tenantId, incidentId): Promise<string> {
      const row = await loadIncident(tenantId, incidentId);
      return row?.status ?? "missing";
    },

    async notifyResponders(
      tenantId,
      incidentId,
      phase: ResponsePhase,
    ): Promise<void> {
      const inc = await loadIncident(tenantId, incidentId);
      if (!inc || inc.status !== UNACKNOWLEDGED) return; // already picked up
      const recipients = [inc.assignedTo, inc.reportedBy].filter(
        (id): id is string => Boolean(id),
      );
      if (recipients.length === 0) return;
      const title =
        phase === "page"
          ? `Incident needs response: ${inc.summary}`
          : `Reminder — unacknowledged incident: ${inc.summary}`;
      await deps.notifications.notifyUsers(tenantId, recipients, {
        kind: "incident.response",
        title,
        body: `SEV-${inc.severity} · ${inc.region} · ${inc.type}`,
        link: `/incidents/${incidentId}`,
      });
    },

    async escalateIncident(tenantId, incidentId): Promise<void> {
      // Re-check still-unacknowledged + find escalation recipients in ONE tenant
      // tx (rbac.usersWithPermission joins the ambient tx). Query inline to avoid
      // nesting runForTenant inside runForTenant.
      const data = await deps.db.runForTenant(tenantId, async () => {
        const tx = deps.db.getCurrentTx()!;
        const inc = (
          await tx
            .select({
              summary: schema.incidents.summary,
              severity: schema.incidents.severity,
              region: schema.incidents.region,
              status: schema.incidents.status,
            })
            .from(schema.incidents)
            .where(
              and(
                eq(schema.incidents.id, incidentId),
                isNull(schema.incidents.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (!inc || inc.status !== UNACKNOWLEDGED) return null;
        const resolvers = await deps.rbac.usersWithPermission(
          "incident",
          "resolve",
        );
        return { inc, resolvers };
      });
      if (!data) return;

      if (data.resolvers.length > 0) {
        await deps.notifications.notifyUsers(tenantId, data.resolvers, {
          kind: "incident.escalated",
          title: `ESCALATED — unacknowledged incident: ${data.inc.summary}`,
          body: `SEV-${data.inc.severity} · ${data.inc.region} · unacknowledged past SLA`,
          link: `/incidents/${incidentId}`,
        });
      }
      await deps.outbox.publish({
        tenantId,
        aggregateType: "incident",
        aggregateId: incidentId,
        eventType: "escalated",
        payload: { incidentId, reason: "ack_sla_breached" },
      });
      logger.log(`incident ${incidentId} escalated (ack SLA breached)`);
    },
  };
}
