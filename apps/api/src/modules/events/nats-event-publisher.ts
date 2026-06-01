import { Logger } from "@nestjs/common";
import {
  connect,
  JSONCodec,
  type JetStreamClient,
  type NatsConnection,
} from "nats";
import type { EventEnvelope } from "@cmc/contracts";
import type { EventPublisher } from "./event-publisher";

/**
 * Real NATS JetStream publisher (P2.1b / ADR-0031). Loaded lazily by the
 * factory only when `NATS_ENABLED`, so the `nats` package never enters the
 * jest runtime.
 */
export class NatsEventPublisher implements EventPublisher {
  readonly active = true;
  private readonly logger = new Logger("NatsEventPublisher");
  private readonly codec = JSONCodec<EventEnvelope>();
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;

  constructor(
    private readonly url: string,
    private readonly stream: string,
  ) {}

  async init(): Promise<void> {
    this.nc = await connect({ servers: this.url, name: "cmc-relay" });
    this.js = this.nc.jetstream();
    const jsm = await this.nc.jetstreamManager();
    // Ensure the stream capturing every event subject exists (idempotent).
    try {
      await jsm.streams.info(this.stream);
    } catch {
      await jsm.streams.add({ name: this.stream, subjects: ["tenant.>"] });
    }
    this.logger.log(
      `NATS connected (${this.url}); JetStream stream "${this.stream}" ready`,
    );
  }

  async publish(
    subject: string,
    envelope: EventEnvelope,
    msgId: string,
  ): Promise<void> {
    if (!this.js) throw new Error("NATS publisher not initialised");
    // `msgID` enables JetStream server-side dedup within the stream's
    // duplicate window — so an at-least-once relay re-publish is collapsed.
    await this.js.publish(subject, this.codec.encode(envelope), {
      msgID: msgId,
    });
  }

  async close(): Promise<void> {
    if (this.nc) await this.nc.drain();
    this.nc = null;
    this.js = null;
  }
}
