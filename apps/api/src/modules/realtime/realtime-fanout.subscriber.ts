import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NatsConnection } from "nats";
import { EventEnvelopeSchema } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { RealtimeRegistryService } from "./realtime-registry.service";

/**
 * Bridges the NATS event plane to the WebSocket registry (P2.3b / ADR-0035):
 * an **ephemeral** JetStream consumer (per process) with `DeliverPolicy.New`,
 * broadcasting each event to the sockets whose tenant-scoped, RBAC-checked
 * subscriptions match. Gated on NATS + realtime; skipped in tests. `nats` is
 * dynamic-imported so it never enters jest.
 *
 * Why ephemeral (not a shared durable like the work-queue consumers): realtime
 * is **fan-out** — every instance must see every event. A shared durable would
 * load-balance and starve half the sockets. Cross-instance fan-out at real
 * scale is the Redis pub/sub step (forward-looking). Why `DeliverPolicy.New`:
 * a freshly-connected browser wants live events, not stream history. Delivery
 * is best-effort — a failed broadcast is never redelivered to a browser.
 */
@Injectable()
export class RealtimeFanoutSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeFanoutSubscriber.name);
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly stream: string;
  private readonly isTest: boolean;
  private nc: NatsConnection | null = null;
  private running = false;

  constructor(
    private readonly registry: RealtimeRegistryService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled =
      config.get("NATS_ENABLED", { infer: true }) &&
      config.get("REALTIME_ENABLED", { infer: true });
    this.url = config.get("NATS_URL", { infer: true });
    this.stream = config.get("NATS_STREAM", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { connect, JSONCodec, AckPolicy, DeliverPolicy } = await import(
      "nats"
    );
    this.nc = await connect({ servers: this.url, name: "cmc-realtime-fanout" });
    const jsm = await this.nc.jetstreamManager();
    // Ensure the stream exists (idempotent) — we can boot before the relay's
    // publisher creates it.
    try {
      await jsm.streams.info(this.stream);
    } catch {
      await jsm.streams.add({ name: this.stream, subjects: ["tenant.>"] });
    }
    // Ephemeral (no durable_name): a private consumer for THIS process; the
    // server auto-cleans it after `inactive_threshold` if we die.
    const ci = await jsm.consumers.add(this.stream, {
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      filter_subjects: ["tenant.>"],
      inactive_threshold: 60_000_000_000, // 60s in nanoseconds
    });

    const js = this.nc.jetstream();
    const consumer = await js.consumers.get(this.stream, ci.name);
    const messages = await consumer.consume();
    const codec = JSONCodec();
    this.running = true;

    void (async () => {
      for await (const m of messages) {
        if (!this.running) break;
        try {
          const parsed = EventEnvelopeSchema.safeParse(codec.decode(m.data));
          if (parsed.success) {
            this.registry.broadcast(
              m.subject,
              parsed.data as unknown as Record<string, unknown>,
            );
          }
        } catch (err) {
          this.logger.debug(
            `fan-out failed for ${m.subject}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          m.ack(); // best-effort: never redeliver a realtime event to a browser
        }
      }
    })();

    this.logger.log(`realtime fan-out subscribed (ephemeral) on ${this.stream}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.nc) await this.nc.drain();
    this.nc = null;
  }
}
