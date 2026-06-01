import { z } from "zod";

/** Current envelope schema version (bump on a breaking envelope change). */
export const EVENT_ENVELOPE_VERSION = 1;
/** Subject scope token for tenant-less / platform events. */
export const EVENT_SYSTEM_SCOPE = "system" as const;

/**
 * The standard event envelope (P2.1 / ADR-0031): the shared contract between
 * producers (the `outbox`), the relay, and every consumer. One outbox row ⇄ one
 * envelope ⇄ one NATS message. `id` is the dedup key — publishing and consuming
 * are both at-least-once.
 *
 *   - `aggregateType` / `eventType` are dot-free NATS subject tokens
 *     (`incident` / `created`); the human event name is `aggregateType.eventType`.
 *   - `version` lets a payload shape evolve without breaking old consumers.
 *   - `causationId` links an event to the event that caused it (causation chain).
 */
export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  eventType: z.string().min(1),
  version: z.number().int().positive(),
  payload: z.record(z.unknown()),
  occurredAt: z.string(),
  traceId: z.string().nullable(),
  causationId: z.string().uuid().nullable(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * NATS subject for an event:
 * `tenant.{scope}.{aggregateType}.{eventType}.v{version}`.
 * Tenant-less events use the `system` scope. A consumer subscribes with
 * wildcards, e.g. `tenant.*.incident.*.v1` or `tenant.{id}.>`.
 */
export function eventSubject(e: {
  tenantId: string | null;
  aggregateType: string;
  eventType: string;
  version: number;
}): string {
  const scope = e.tenantId ?? EVENT_SYSTEM_SCOPE;
  return `tenant.${scope}.${e.aggregateType}.${e.eventType}.v${e.version}`;
}

/** Outbox → NATS relay status (P2.1b). */
export const EventRelayStatusResponseSchema = z.object({
  /** Whether the publisher is live (NATS connected / enabled). */
  active: z.boolean(),
  /** Whether the background relay interval is running. */
  enabled: z.boolean(),
  /** Unpublished outbox rows awaiting the relay. */
  pending: z.number().int(),
  /** JetStream stream name. */
  stream: z.string(),
});
export type EventRelayStatusResponse = z.infer<
  typeof EventRelayStatusResponseSchema
>;

export const EventRelayFlushResponseSchema = z.object({
  /** Rows published to NATS by this flush. */
  published: z.number().int(),
});
export type EventRelayFlushResponse = z.infer<
  typeof EventRelayFlushResponseSchema
>;
