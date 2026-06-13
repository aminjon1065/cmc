import type {
  EventEnvelope,
  IncidentDetail,
  IncidentStatus,
} from "@cmc/contracts";

/**
 * In-process domain events (ADR-0080). Cross-module reactions run on the Nest
 * `EventEmitter` instead of a network broker (NATS was removed); a domain
 * service emits one of these AFTER its state change, synchronously within the
 * request transaction, and `@OnEvent` listeners react.
 *
 * The event name is `aggregateType.eventType` (matching the outbox/envelope
 * naming). The payload carries the **already-loaded** `detail` so listeners
 * never re-fetch — a re-fetch would open a separate transaction that can't see
 * the still-uncommitted request state. The `envelope` lets the realtime fan-out
 * compute its subject + broadcast the same shape the bus used to.
 */
export const DomainEvent = {
  IncidentTransitioned: "incident.transitioned",
  IncidentAssigned: "incident.assigned",
} as const;

/** The actor that triggered a domain event. */
export type DomainActor = { userId: string; tenantId: string };

export type IncidentTransitionedEvent = {
  envelope: EventEnvelope;
  detail: IncidentDetail;
  from: IncidentStatus;
  to: IncidentStatus;
  actor: DomainActor;
};

export type IncidentAssignedEvent = {
  envelope: EventEnvelope;
  detail: IncidentDetail;
  actor: DomainActor;
};
