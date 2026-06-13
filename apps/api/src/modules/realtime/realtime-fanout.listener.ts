import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { eventSubject, type EventEnvelope } from "@cmc/contracts";
import { RealtimeRegistryService } from "./realtime-registry.service";
import {
  DomainEvent,
  type IncidentAssignedEvent,
  type IncidentTransitionedEvent,
} from "../events/domain-events";

/**
 * Bridges in-process domain events → subscribed WebSocket sockets (ADR-0035;
 * in-process per ADR-0080, replacing the NATS fan-out subscriber). Broadcasts
 * the event envelope to every socket whose tenant-scoped, RBAC-checked
 * subscription matches the subject. Best-effort + DB-side-effect-free, so it is
 * safe to run synchronously within the emitting request (a never-delivered push
 * is acceptable; the browser re-syncs on its next action).
 */
@Injectable()
export class RealtimeFanoutListener {
  private readonly logger = new Logger(RealtimeFanoutListener.name);

  constructor(private readonly registry: RealtimeRegistryService) {}

  @OnEvent(DomainEvent.IncidentTransitioned)
  onTransitioned(ev: IncidentTransitionedEvent): void {
    this.broadcast(ev.envelope);
  }

  @OnEvent(DomainEvent.IncidentAssigned)
  onAssigned(ev: IncidentAssignedEvent): void {
    this.broadcast(ev.envelope);
  }

  private broadcast(envelope: EventEnvelope): void {
    try {
      this.registry.broadcast(
        eventSubject(envelope),
        envelope as unknown as Record<string, unknown>,
      );
    } catch (err) {
      this.logger.debug(
        `realtime fan-out failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
