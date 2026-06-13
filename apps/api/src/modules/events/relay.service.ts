import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, count, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  eventSubject,
  type EventEnvelope,
  type EventRelayFlushResponse,
  type EventRelayStatusResponse,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { EVENT_PUBLISHER, type EventPublisher } from "./event-publisher";
import type { AppConfig } from "../../config/configuration";

type OutboxRow = typeof schema.outbox.$inferSelect;

/** Advisory-lock key so only one relay runs at a time cluster-wide. */
const RELAY_LOCK_KEY = 40_211_300;

/**
 * Outbox → NATS relay (P2.1b / ADR-0031).
 *
 * Polls unpublished outbox rows in `seq` order, publishes each to its subject
 * via the `EventPublisher`, and stamps `published_at` — in the SAME transaction,
 * so a publish failure rolls the stamp back and the row re-ships next run.
 * At-least-once; the broker dedups on the event id (`msgID`). `flush()` is the
 * unit of work (interval / endpoint / test); `publisher.active` guards against
 * stamping rows we never actually delivered. Off by default (ADR-0080): the
 * publisher is the noop, so the relay idles and the outbox simply fills.
 */
@Injectable()
export class RelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelayService.name);
  private readonly enabled: boolean;
  private readonly intervalSec: number;
  private readonly batchSize: number;
  private readonly stream: string;
  private readonly isTest: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    config: ConfigService<AppConfig, true>,
  ) {
    // No broker by default (ADR-0080): the publisher is the noop, so the relay
    // idles regardless. The interval/batch config stays for when a broker
    // publisher is reintroduced on service extraction.
    this.enabled = false;
    this.intervalSec = config.get("EVENTS_RELAY_INTERVAL_SEC", { infer: true });
    this.batchSize = config.get("EVENTS_RELAY_BATCH_SIZE", { infer: true });
    this.stream = "";
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  async onModuleInit(): Promise<void> {
    if (!this.publisher.active || this.isTest) return;
    await this.publisher.init();
    if (this.intervalSec > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch((err) =>
          this.logger.error(
            `relay flush failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }, this.intervalSec * 1000);
      this.timer.unref?.();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.publisher.active) await this.publisher.close();
  }

  private toEnvelope(row: OutboxRow): EventEnvelope {
    return {
      id: row.id,
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      version: row.version,
      payload: row.payload as Record<string, unknown>,
      occurredAt: row.occurredAt.toISOString(),
      traceId: row.traceId,
      causationId: row.causationId,
    };
  }

  /** Publish one batch of unpublished events; stamp them published. */
  async flush(): Promise<EventRelayFlushResponse> {
    if (!this.publisher.active) return { published: 0 };

    return this.tenantDb.runPrivileged(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RELAY_LOCK_KEY})`);

      const rows = await tx
        .select()
        .from(schema.outbox)
        .where(isNull(schema.outbox.publishedAt))
        .orderBy(asc(schema.outbox.seq))
        .limit(this.batchSize);
      if (rows.length === 0) return { published: 0 };

      let published = 0;
      for (const row of rows) {
        const envelope = this.toEnvelope(row);
        // A publish failure throws → the tx rolls back → no stamp → re-ship.
        await this.publisher.publish(eventSubject(envelope), envelope, row.id);
        await tx
          .update(schema.outbox)
          .set({ publishedAt: new Date() })
          .where(eq(schema.outbox.id, row.id));
        published++;
      }
      return { published };
    });
  }

  async status(): Promise<EventRelayStatusResponse> {
    const pending = await this.tenantDb.runPrivileged(async (tx) => {
      const [r] = await tx
        .select({ pending: count() })
        .from(schema.outbox)
        .where(isNull(schema.outbox.publishedAt));
      return Number(r?.pending ?? 0);
    });
    return {
      active: this.publisher.active,
      enabled: this.enabled && this.intervalSec > 0,
      pending,
      stream: this.stream,
    };
  }
}
