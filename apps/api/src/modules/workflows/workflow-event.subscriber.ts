import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NatsConnection } from "nats";
import { EventEnvelopeSchema } from "@cmc/contracts";
import { WorkflowEventConsumer } from "./workflow-event.consumer";
import type { AppConfig } from "../../config/configuration";

const DURABLE = "workflow-trigger";
// Every tenant event — the handler matches each against bound workflows.
const FILTER_SUBJECTS = ["tenant.>"];

/**
 * Drives {@link WorkflowEventConsumer} from a durable JetStream consumer
 * (P3.8c / ADR-0053). Gated on `NATS_ENABLED` + skipped in tests (the handler
 * is unit-tested directly). Mirrors the incident-notifications subscriber
 * (P2.4b): `nats` dynamic-imported, explicit-ack with `nak` on failure →
 * at-least-once, the handler's dedup makes redelivery safe.
 */
@Injectable()
export class WorkflowEventSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowEventSubscriber.name);
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly stream: string;
  private readonly isTest: boolean;
  private nc: NatsConnection | null = null;
  private running = false;

  constructor(
    private readonly handler: WorkflowEventConsumer,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("NATS_ENABLED", { infer: true });
    this.url = config.get("NATS_URL", { infer: true });
    this.stream = config.get("NATS_STREAM", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { connect, JSONCodec, AckPolicy, DeliverPolicy } = await import("nats");
    this.nc = await connect({ servers: this.url, name: "cmc-workflow-trigger" });
    const jsm = await this.nc.jetstreamManager();
    await jsm.consumers
      .add(this.stream, {
        durable_name: DURABLE,
        ack_policy: AckPolicy.Explicit,
        // Forward-only: a fresh consumer must not replay history + re-trigger.
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

    this.logger.log(`subscribed durable "${DURABLE}" on ${this.stream}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.nc) await this.nc.drain();
    this.nc = null;
  }
}
