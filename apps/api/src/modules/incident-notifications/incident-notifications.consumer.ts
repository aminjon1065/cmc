import { Injectable, Logger } from "@nestjs/common";
import type { EventEnvelope, IncidentStatus } from "@cmc/contracts";
import { IncidentsService } from "../incidents/incidents.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EventDedupService } from "../events/event-dedup.service";

/** Idempotency-ledger consumer name. */
const CONSUMER = "incident-notifications";

/** Incident event verbs this consumer reacts to. */
const HANDLED = new Set(["assigned", "transitioned"]);

/**
 * Reacts to incident events from the bus (P2.4 / ADR-0032) and dispatches the
 * in-app/email notifications — the event-driven replacement for the inline
 * dispatch in `IncidentsService` (which now only fires when the event plane is
 * off). `handle()` is the pure unit of work: idempotent (claims the event id),
 * tenant-scoped, best-effort. The NATS subscription that drives it lands in
 * P2.4b; tests call `handle()` directly.
 */
@Injectable()
export class IncidentNotificationsConsumer {
  private readonly logger = new Logger(IncidentNotificationsConsumer.name);

  constructor(
    private readonly incidents: IncidentsService,
    private readonly notifications: NotificationsService,
    private readonly dedup: EventDedupService,
  ) {}

  async handle(env: EventEnvelope): Promise<void> {
    if (env.aggregateType !== "incident" || !HANDLED.has(env.eventType)) return;
    if (!env.tenantId) return; // incident events are always tenant-scoped

    // At-least-once → claim first; a redelivery is a no-op.
    if (!(await this.dedup.claim(env.id, CONSUMER))) return;

    const detail = await this.incidents.getDetailForTenant(
      env.tenantId,
      env.aggregateId,
    );
    if (!detail) {
      this.logger.warn(
        `incident ${env.aggregateId} not found; skipping ${env.eventType}`,
      );
      return;
    }

    const payload = env.payload as {
      by?: string;
      from?: string;
      to?: string;
    };
    const actor = { userId: payload.by ?? "", tenantId: env.tenantId };

    if (env.eventType === "assigned") {
      await this.notifications.incidentAssigned(detail, actor);
    } else {
      await this.notifications.incidentTransitioned(
        detail,
        payload.from as IncidentStatus,
        payload.to as IncidentStatus,
        actor,
      );
    }
  }
}
