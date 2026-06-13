import type { EventEnvelope } from "@cmc/contracts";

/** DI token for the outbox relay's broker publisher. */
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/**
 * Publishes outbox events to an external broker. The transactional outbox + the
 * relay remain in place as the durability seam (ADR-0080), but cross-module
 * reactions now run **in-process** (Nest `EventEmitter`) — so the default
 * publisher is the **noop**: nothing is shipped anywhere and the relay idles. A
 * real broker publisher (e.g. NATS) is reintroduced only when a module is
 * actually extracted into a separate service. The relay e2e fakes this seam.
 */
export interface EventPublisher {
  /** True when the publisher can actually deliver (a broker is configured). */
  readonly active: boolean;
  /** Connect + ensure the destination exists. Idempotent. */
  init(): Promise<void>;
  /** Publish one envelope to its subject; `msgId` is the dedup key. */
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
 * Factory: the noop publisher (no broker by default — ADR-0080). The outbox
 * still fills inside each transaction; the relay simply doesn't drain it until a
 * broker publisher is wired in on service extraction.
 */
export function createEventPublisher(): EventPublisher {
  return new NoopEventPublisher();
}
