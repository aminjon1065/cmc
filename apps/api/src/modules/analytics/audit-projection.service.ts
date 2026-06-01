import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { asc, count, eq, gt, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  AuditProjectionFlushResponse,
  AuditProjectionStatusResponse,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { CLICKHOUSE_CLIENT, type ClickHouseClient } from "./clickhouse.client";
import type { AppConfig } from "../../config/configuration";

const PROJECTION_LOCK_KEY = 40_211_400;
const CONSUMER = "audit-clickhouse";

type AuditRow = typeof schema.auditLog.$inferSelect;

/**
 * Projects the append-only audit log into ClickHouse for analytics + long-term
 * retention (P2.2 / ADR-0034). The audit log is a firehose, so this is a
 * cursor-tail ETL (not the event bus): `flush()` reads `audit_log` by `seq`
 * past the `projection_cursors` position, bulk-inserts into `cmc.audit_events`
 * (the MV rolls up daily stats), and advances the cursor — all under an
 * advisory lock. At-least-once (a crash window can re-project; analytics
 * tolerate the rare duplicate). `flush()` always runs; the background interval
 * is gated by ClickHouse being reachable.
 */
@Injectable()
export class AuditProjectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditProjectionService.name);
  private readonly intervalSec: number;
  private readonly batchSize: number;
  private readonly isTest: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
    config: ConfigService<AppConfig, true>,
  ) {
    this.intervalSec = config.get("AUDIT_PROJECTION_INTERVAL_SEC", {
      infer: true,
    });
    this.batchSize = config.get("AUDIT_PROJECTION_BATCH_SIZE", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  onModuleInit(): void {
    if (!this.ch.active || this.intervalSec <= 0 || this.isTest) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) =>
        this.logger.error(
          `audit projection failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.intervalSec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private toChDateTime(iso: string): string {
    return iso.slice(0, 23).replace("T", " ");
  }

  private toChRow(row: AuditRow): Record<string, unknown> {
    return {
      id: row.id,
      seq: row.seq,
      tenant_id: row.tenantId,
      actor_id: row.actorId,
      actor_type: row.actorType,
      action: row.action,
      resource_type: row.resourceType,
      resource_id: row.resourceId ?? "",
      outcome: row.outcome,
      ip: row.ip,
      request_id: row.requestId,
      trace_id: row.traceId,
      occurred_at: this.toChDateTime(row.occurredAt.toISOString()),
    };
  }

  async flush(): Promise<AuditProjectionFlushResponse> {
    if (!this.ch.active) {
      return { projected: 0, cursorSeq: await this.readCursor() };
    }
    return this.tenantDb.runPrivileged(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${PROJECTION_LOCK_KEY})`);

      const [cur] = await tx
        .select()
        .from(schema.projectionCursors)
        .where(eq(schema.projectionCursors.consumer, CONSUMER))
        .limit(1);
      const cursor = cur?.lastSeq ?? 0;

      const rows = await tx
        .select()
        .from(schema.auditLog)
        .where(gt(schema.auditLog.seq, cursor))
        .orderBy(asc(schema.auditLog.seq))
        .limit(this.batchSize);
      if (rows.length === 0) return { projected: 0, cursorSeq: cursor };

      // Side effect outside the DB — if it throws, the tx rolls back and the
      // cursor stays, so the batch re-projects (at-least-once).
      await this.ch.insert("audit_events", rows.map((r) => this.toChRow(r)));

      const newCursor = rows[rows.length - 1]!.seq;
      await tx
        .insert(schema.projectionCursors)
        .values({ consumer: CONSUMER, lastSeq: newCursor, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.projectionCursors.consumer,
          set: { lastSeq: newCursor, updatedAt: new Date() },
        });

      return { projected: rows.length, cursorSeq: newCursor };
    });
  }

  private async readCursor(): Promise<number> {
    return this.tenantDb.runPrivileged(async (tx) => {
      const [cur] = await tx
        .select()
        .from(schema.projectionCursors)
        .where(eq(schema.projectionCursors.consumer, CONSUMER))
        .limit(1);
      return cur?.lastSeq ?? 0;
    });
  }

  async status(): Promise<AuditProjectionStatusResponse> {
    return this.tenantDb.runPrivileged(async (tx) => {
      const [cur] = await tx
        .select()
        .from(schema.projectionCursors)
        .where(eq(schema.projectionCursors.consumer, CONSUMER))
        .limit(1);
      const cursor = cur?.lastSeq ?? 0;
      const [p] = await tx
        .select({ pending: count() })
        .from(schema.auditLog)
        .where(gt(schema.auditLog.seq, cursor));
      return {
        active: this.ch.active,
        cursorSeq: cursor,
        pending: Number(p?.pending ?? 0),
      };
    });
  }
}
