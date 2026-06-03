import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { NotificationsService } from "../notifications/notifications.service";
import { REDIS } from "../redis/redis.tokens";
import { CLICKHOUSE_CLIENT, type ClickHouseClient } from "./clickhouse.client";
import { DashboardAnalyticsService } from "./dashboard-analytics.service";
import type { AppConfig } from "../../config/configuration";

/** Only alert on anomalies from the last N days (not the whole backfill window). */
const RECENT_DAYS = 2;
/** Dedup window — one alert per (tenant, day, direction). */
const DEDUP_TTL_SEC = 14 * 24 * 3600;

/**
 * Proactive realtime-anomaly alerting (P4.8b / ADR-0066). A background scan runs
 * the P4.8a Z-score detector per tenant and, for each NEW recent anomaly, fans a
 * notification out to `monitoring:read` holders — deduped once per
 * (tenant, day, direction) via a Redis key. Gated: only when both the detector
 * flag and ClickHouse are on, and never under jest (the interval is skipped;
 * `scan()` is called directly in tests). The on-demand endpoint (P4.8a) is
 * unaffected.
 */
@Injectable()
export class AnomalyAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnomalyAlertService.name);
  private readonly enabled: boolean;
  private readonly intervalSec: number;
  private readonly isTest: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly dashboard: DashboardAnalyticsService,
    private readonly notifications: NotificationsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("ANALYTICS_ANOMALY_DETECTOR_ENABLED", {
      infer: true,
    });
    this.intervalSec = config.get("ANALYTICS_ANOMALY_INTERVAL_SEC", {
      infer: true,
    });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
  }

  onModuleInit(): void {
    if (
      !this.enabled ||
      !this.ch.active ||
      this.intervalSec <= 0 ||
      this.isTest
    ) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scan().catch((err) =>
        this.logger.error(
          `anomaly scan failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.intervalSec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Scan every tenant for recent anomalies and notify `monitoring:read` holders,
   * once per (tenant, day, direction). Returns the number of NEW alerts
   * dispatched. Directly callable (tests) — the interval is gated off there.
   */
  async scan(): Promise<number> {
    if (!this.ch.active) return 0;

    const tenantIds = await this.tenantDb
      .runPrivileged((tx) =>
        tx
          .select({ id: schema.tenants.id })
          .from(schema.tenants)
          .where(isNull(schema.tenants.deletedAt)),
      )
      .then((rows) => rows.map((r) => r.id));

    const cutoff = recentCutoff(RECENT_DAYS);
    let dispatched = 0;

    for (const tenantId of tenantIds) {
      let recent;
      try {
        const res = await this.dashboard.anomalies(tenantId);
        recent = res.anomalies.filter((a) => a.day >= cutoff);
      } catch (err) {
        this.logger.warn(
          `anomalies(${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      for (const a of recent) {
        const key = `cmc:anomaly:${tenantId}:${a.day}:${a.direction}`;
        const isNew = await this.redis.set(key, "1", "EX", DEDUP_TTL_SEC, "NX");
        if (isNew !== "OK") continue; // already alerted

        const recipients = await this.recipients(tenantId);
        if (recipients.length === 0) continue;

        await this.notifications.notifyUsers(tenantId, recipients, {
          kind: "analytics.anomaly",
          title: `Anomaly: ${a.count} incidents on ${a.day} (${a.direction})`,
          body: `Baseline ~${a.mean} (z=${a.z}). Review the analytics dashboard.`,
          link: "/dashboard",
        });
        dispatched++;
      }
    }
    return dispatched;
  }

  /** `monitoring:read` holders in a tenant (privileged, tenant-filtered). */
  private async recipients(tenantId: string): Promise<string[]> {
    const rows = await this.tenantDb.runPrivileged((tx) =>
      tx
        .selectDistinct({ userId: schema.userRoles.userId })
        .from(schema.userRoles)
        .innerJoin(
          schema.rolePermissions,
          eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
        )
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(
          and(
            eq(schema.userRoles.tenantId, tenantId),
            eq(schema.permissions.domain, "monitoring"),
            eq(schema.permissions.action, "read"),
          ),
        ),
    );
    return rows.map((r) => r.userId);
  }
}

/** YYYY-MM-DD `RECENT_DAYS-1` days before today (UTC). */
function recentCutoff(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}
