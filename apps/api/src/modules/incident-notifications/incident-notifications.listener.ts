import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { NotificationsService } from "../notifications/notifications.service";
import {
  DomainEvent,
  type IncidentAssignedEvent,
  type IncidentTransitionedEvent,
} from "../events/domain-events";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Bridges incident domain events → notifications (ADR-0032; in-process events
 * per ADR-0080, replacing the NATS consumer). `@OnEvent` listeners run
 * synchronously inside the emitting request transaction (the envelope carries
 * the already-loaded `detail`, so there is no separate-transaction re-fetch),
 * so the notification rows commit atomically with the incident change.
 * Best-effort: a notification failure is logged, never thrown to the request.
 */
@Injectable()
export class IncidentNotificationsListener {
  private readonly logger = new Logger(IncidentNotificationsListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  @OnEvent(DomainEvent.IncidentTransitioned)
  async onTransitioned(ev: IncidentTransitionedEvent): Promise<void> {
    try {
      await this.notifications.incidentTransitioned(
        ev.detail,
        ev.from,
        ev.to,
        ev.actor,
      );
    } catch (err) {
      this.logger.warn(`incident.transitioned notify failed: ${msg(err)}`);
    }
  }

  @OnEvent(DomainEvent.IncidentAssigned)
  async onAssigned(ev: IncidentAssignedEvent): Promise<void> {
    try {
      await this.notifications.incidentAssigned(ev.detail, ev.actor);
    } catch (err) {
      this.logger.warn(`incident.assigned notify failed: ${msg(err)}`);
    }
  }
}
