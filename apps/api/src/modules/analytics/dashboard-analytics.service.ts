import { Injectable } from "@nestjs/common";
import { and, gte, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { DashboardAnalyticsResponse } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import {
  RegionScopeService,
  regionScopeCondition,
} from "../regions/region-scope.service";
import { buildDailyTrend } from "./dashboard-trend";

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 14;

/**
 * Dashboard analytics computed from **PostgreSQL** (ToR v2.0 §5; ADR-0080 —
 * ClickHouse + the realtime-anomaly plane were removed). Serves the daily
 * incident-volume trend the OLTP `/incidents/stats` snapshot doesn't compute,
 * straight from the `incidents` table. RLS scopes it to the current tenant (the
 * request runs in a tenant transaction); region scope (P4.6b) confines regional
 * staff to their region while `region:all` holders see every region.
 */
@Injectable()
export class DashboardAnalyticsService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly regionScope: RegionScopeService,
  ) {}

  async dashboard(
    days = DEFAULT_WINDOW_DAYS,
  ): Promise<DashboardAnalyticsResponse> {
    const windowDays = Math.min(
      Math.max(Math.trunc(days) || DEFAULT_WINDOW_DAYS, 1),
      MAX_WINDOW_DAYS,
    );

    const scope = await this.regionScope.current();
    const rc = regionScopeCondition(schema.incidents.regionId, scope);

    // Window = [today - (windowDays - 1), today] in UTC, computed once so the
    // SQL cutoff and the gap-fill below share the same "today".
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - (windowDays - 1));
    const cutoffDay = cutoff.toISOString().slice(0, 10);

    const rows = await this.tenantDb.run((tx) =>
      tx
        .select({
          bucket: sql<string>`to_char((${schema.incidents.occurredAt} at time zone 'UTC')::date, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.incidents)
        .where(
          and(
            isNull(schema.incidents.deletedAt),
            gte(schema.incidents.occurredAt, sql`${cutoffDay}::date`),
            ...(rc ? [rc] : []),
          ),
        )
        .groupBy(sql`1`),
    );

    const incidentTrend = buildDailyTrend(
      rows.map((r) => ({ day: r.bucket, count: Number(r.count) })),
      windowDays,
      today,
    );
    return { source: "postgres", windowDays, incidentTrend };
  }
}
