import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { hostname } from "node:os";
import { ConfigService } from "@nestjs/config";
import { asc, count, eq, gt, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  AuditExportFlushResponse,
  AuditExportFormat,
  AuditExportStatusResponse,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AUDIT_EXPORT_SINK, type AuditExportSink } from "./audit-export.sink";
import {
  formatCef,
  formatRfc5424,
  type AuditRow,
} from "./audit-export.formatters";
import type { AppConfig } from "../../config/configuration";

/** Advisory-lock key so only one exporter runs at a time cluster-wide. */
const EXPORT_LOCK_KEY = 40_211_200;

/**
 * SIEM audit-export worker (P1.12 / ADR-0030).
 *
 * Tail-reads the (tamper-evident) audit log by `seq` cursor, formats each row as
 * RFC 5424 / CEF, and ships it to the configured sink. Runs privileged
 * (`runPrivileged`) — reads all tenants + the durable cursor. `flush()` is the
 * unit of work and ALWAYS runs (manual / endpoint / interval); `enabled` only
 * gates the background timer. Delivery is at-least-once: the cursor advances
 * only after the sink write succeeds and the tx commits, so a crash re-ships
 * (the SIEM dedups on the row id) but never drops.
 */
@Injectable()
export class AuditExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditExportService.name);
  private readonly enabled: boolean;
  private readonly format: AuditExportFormat;
  private readonly intervalSec: number;
  private readonly batchSize: number;
  private readonly host: string;
  private readonly isTest: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    @Inject(AUDIT_EXPORT_SINK) private readonly sink: AuditExportSink,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("AUDIT_EXPORT_ENABLED", { infer: true });
    this.format = config.get("AUDIT_EXPORT_FORMAT", { infer: true });
    this.intervalSec = config.get("AUDIT_EXPORT_INTERVAL_SEC", { infer: true });
    this.batchSize = config.get("AUDIT_EXPORT_BATCH_SIZE", { infer: true });
    this.host =
      config.get("AUDIT_EXPORT_HOSTNAME", { infer: true }) ?? hostname();
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  onModuleInit(): void {
    if (!this.enabled || this.intervalSec <= 0 || this.isTest) return;
    this.timer = setInterval(() => {
      void this.flush().catch((err) =>
        this.logger.error(
          `audit export failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.intervalSec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private formatRow(row: AuditRow): string {
    return this.format === "cef"
      ? formatCef(row)
      : formatRfc5424(row, this.host);
  }

  /** Ship one batch of unexported rows; advance the cursor. Idempotent-safe. */
  async flush(): Promise<AuditExportFlushResponse> {
    return this.tenantDb.runPrivileged(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${EXPORT_LOCK_KEY})`);

      const [cur] = await tx
        .select()
        .from(schema.auditExportCursor)
        .where(eq(schema.auditExportCursor.id, 1))
        .limit(1);
      const cursor = cur?.lastSeq ?? 0;

      const rows = await tx
        .select()
        .from(schema.auditLog)
        .where(gt(schema.auditLog.seq, cursor))
        .orderBy(asc(schema.auditLog.seq))
        .limit(this.batchSize);
      if (rows.length === 0) return { exported: 0, cursorSeq: cursor };

      // Side effect outside the DB — if it throws, the tx rolls back and the
      // cursor stays put, so the batch re-ships next run (at-least-once).
      await this.sink.write(rows.map((r) => this.formatRow(r)));

      const newCursor = rows[rows.length - 1]!.seq;
      await tx
        .insert(schema.auditExportCursor)
        .values({ id: 1, lastSeq: newCursor, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.auditExportCursor.id,
          set: { lastSeq: newCursor, updatedAt: new Date() },
        });

      return { exported: rows.length, cursorSeq: newCursor };
    });
  }

  async status(): Promise<AuditExportStatusResponse> {
    return this.tenantDb.runPrivileged(async (tx) => {
      const [cur] = await tx
        .select()
        .from(schema.auditExportCursor)
        .where(eq(schema.auditExportCursor.id, 1))
        .limit(1);
      const cursor = cur?.lastSeq ?? 0;
      const [pendingRow] = await tx
        .select({ pending: count() })
        .from(schema.auditLog)
        .where(gt(schema.auditLog.seq, cursor));

      return {
        enabled: this.enabled,
        format: this.format,
        transport: this.sink.transport,
        cursorSeq: cursor,
        pending: Number(pendingRow?.pending ?? 0),
        updatedAt: cur?.updatedAt ? cur.updatedAt.toISOString() : null,
      };
    });
  }
}
