import type { ConfigService } from "@nestjs/config";
import type { EventEnvelope } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";

/** DI token for the event-bus publisher (P2.1b / ADR-0031). */
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/**
 * Publishes outbox events to the event bus (NATS JetStream). The seam the
 * relay e2e fakes — the real `nats` client is only loaded + connected in
 * production, and exercised in the live smoke.
 */
export interface EventPublisher {
  /** True when the publisher can actually deliver (NATS enabled). */
  readonly active: boolean;
  /** Connect + ensure the JetStream stream exists. Idempotent. */
  init(): Promise<void>;
  /** Publish one envelope to its subject; `msgId` is the JetStream dedup key. */
  publish(
    subject: string,
    envelope: EventEnvelope,
    msgId: string,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Disabled publisher — the relay sees `active=false` and idles. */
export class NoopEventPublisher implements EventPublisher {
  readonly active = false;
  async init(): Promise<void> {}
  async publish(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real NATS publisher when enabled, else the noop. The `nats`
 * package is **dynamically imported** only when enabled, so it's never loaded
 * under jest (where NATS_ENABLED is false and the relay e2e overrides this
 * token with a fake).
 */
export async function createEventPublisher(
  config: ConfigService<AppConfig, true>,
): Promise<EventPublisher> {
  if (!config.get("NATS_ENABLED", { infer: true })) {
    return new NoopEventPublisher();
  }
  const { NatsEventPublisher } = await import("./nats-event-publisher");
  return new NatsEventPublisher(
    config.get("NATS_URL", { infer: true }),
    config.get("NATS_STREAM", { infer: true }),
  );
}
