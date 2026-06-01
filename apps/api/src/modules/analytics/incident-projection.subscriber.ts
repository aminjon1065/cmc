import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NatsConnection } from "nats";
import { EventEnvelopeSchema } from "@cmc/contracts";
import { IncidentProjectionConsumer } from "./incident-projection.consumer";
import type { AppConfig } from "../../config/configuration";

const DURABLE = "incident-projection";
const FILTER_SUBJECTS = [
  "tenant.*.incident.created.v1",
  "tenant.*.incident.transitioned.v1",
];

/**
 * Drives {@link IncidentProjectionConsumer} from a durable JetStream consumer
 * (P2.5b / ADR-0033). Needs BOTH NATS (to receive) and ClickHouse (to write);
 * skipped in tests. Unlike the notifications consumer this uses
 * `DeliverPolicy.All` — a projection WANTS to backfill the whole stream; the
 * dedup ledger makes the backfill idempotent. `nats` is dynamic-imported.
 */
@Injectable()
export class IncidentProjectionSubscriber
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IncidentProjectionSubscriber.name);
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly stream: string;
  private readonly isTest: boolean;
  private nc: NatsConnection | null = null;
  private running = false;

  constructor(
    private readonly handler: IncidentProjectionConsumer,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled =
      config.get("NATS_ENABLED", { infer: true }) &&
      config.get("CLICKHOUSE_ENABLED", { infer: true });
    this.url = config.get("NATS_URL", { infer: true });
    this.stream = config.get("NATS_STREAM", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { connect, JSONCodec, AckPolicy, DeliverPolicy } = await import(
      "nats"
    );
    this.nc = await connect({ servers: this.url, name: "cmc-incident-proj" });
    const jsm = await this.nc.jetstreamManager();
    await jsm.consumers
      .add(this.stream, {
        durable_name: DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
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
            `projection failed, will redeliver: ${err instanceof Error ? err.message : String(err)}`,
          );
          m.nak();
        }
      }
    })();

    this.logger.log(
      `subscribed durable "${DURABLE}" on ${this.stream} → ClickHouse`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.nc) await this.nc.drain();
    this.nc = null;
  }
}
