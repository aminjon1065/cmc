import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NatsConnection } from "nats";
import { EventEnvelopeSchema } from "@cmc/contracts";
import { IncidentNotificationsConsumer } from "./incident-notifications.consumer";
import type { AppConfig } from "../../config/configuration";

const DURABLE = "incident-notifications";
const FILTER_SUBJECTS = [
  "tenant.*.incident.assigned.v1",
  "tenant.*.incident.transitioned.v1",
];

/**
 * Drives {@link IncidentNotificationsConsumer} from a durable JetStream
 * consumer (P2.4b / ADR-0032). Gated on `NATS_ENABLED` and skipped in tests
 * (the handler is unit-tested directly). The `nats` package is dynamic-imported
 * so it never enters the jest runtime. Explicit-ack with `nak` on failure →
 * at-least-once; the handler's dedup makes redelivery safe.
 */
@Injectable()
export class IncidentNotificationsSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IncidentNotificationsSubscriber.name);
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly stream: string;
  private readonly isTest: boolean;
  private nc: NatsConnection | null = null;
  private running = false;

  constructor(
    private readonly handler: IncidentNotificationsConsumer,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("NATS_ENABLED", { infer: true });
    this.url = config.get("NATS_URL", { infer: true });
    this.stream = config.get("NATS_STREAM", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { connect, JSONCodec, AckPolicy, DeliverPolicy } = await import(
      "nats"
    );
    this.nc = await connect({ servers: this.url, name: "cmc-incident-notif" });
    const jsm = await this.nc.jetstreamManager();
    // Ensure the durable consumer exists (idempotent — ignore "already in use").
    await jsm.consumers
      .add(this.stream, {
        durable_name: DURABLE,
        ack_policy: AckPolicy.Explicit,
        // New (not All): notifications are forward-only — a freshly-created
        // consumer must NOT replay history and re-notify. Redelivery for THIS
        // consumer is handled by the dedup ledger.
        deliver_policy: DeliverPolicy.New,
        filter_subjects: FILTER_SUBJECTS,
      })
      .catch(() => undefined);

    const js = this.nc.jetstream();
    const consumer = await js.consumers.get(this.stream, DURABLE);
    const messages = await consumer.consume();
    const codec = JSONCodec();
    this.running = true;

    void (async () => {
      for await (const m of messages) {
        if (!this.running) break;
        try {
          const parsed = EventEnvelopeSchema.safeParse(codec.decode(m.data));
          if (parsed.success) await this.handler.handle(parsed.data);
          m.ack();
        } catch (err) {
          this.logger.error(
            `handle failed, will redeliver: ${err instanceof Error ? err.message : String(err)}`,
          );
          m.nak();
        }
      }
    })();

    this.logger.log(
      `subscribed durable "${DURABLE}" on ${this.stream} (${FILTER_SUBJECTS.join(", ")})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.nc) await this.nc.drain();
    this.nc = null;
  }
}
