import { Inject, Injectable } from "@nestjs/common";
import type { DashboardAnalyticsResponse } from "@cmc/contracts";
import { CLICKHOUSE_CLIENT, type ClickHouseClient } from "./clickhouse.client";
import { buildDailyTrend } from "./dashboard-trend";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 14;

/**
 * Dashboard analytics from ClickHouse (P2.6 / ADR-0036). Serves historical
 * trends the OLTP `/incidents/stats` snapshot doesn't compute. Tenant-scoped in
 * the query (ClickHouse has no RLS) — `tenantId` always comes from the verified
 * request context and is asserted to be a UUID before interpolation. Degrades
 * gracefully to `unavailable` when ClickHouse is off/unreachable.
 */
@Injectable()
export class DashboardAnalyticsService {
  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
  ) {}

  async dashboard(
    tenantId: string,
    days = DEFAULT_WINDOW_DAYS,
  ): Promise<DashboardAnalyticsResponse> {
    const windowDays = Math.min(
      Math.max(Math.trunc(days) || DEFAULT_WINDOW_DAYS, 1),
      MAX_WINDOW_DAYS,
    );

    if (!this.ch.active) {
      return { source: "unavailable", windowDays, incidentTrend: [] };
    }
    if (!UUID_RE.test(tenantId)) {
      throw new Error("invalid tenant id"); // defensive — always a verified UUID
    }

    // Alias the day to `bucket` (not `day`) so the String projection never
    // collides with the Date column `day` used in GROUP BY / ORDER BY.
    const rows = await this.ch.query<{ bucket: string; count: string | number }>(
      `SELECT toString(day) AS bucket, toUInt64(sum(incidents)) AS count
       FROM cmc.incident_daily_stats_by_region
       WHERE tenant_id = '${tenantId}' AND day >= subtractDays(today(), ${windowDays - 1})
       GROUP BY day
       ORDER BY day`,
    );

    const today = new Date().toISOString().slice(0, 10);
    const incidentTrend = buildDailyTrend(
      rows.map((r) => ({ day: r.bucket, count: Number(r.count) })),
      windowDays,
      today,
    );
    return { source: "clickhouse", windowDays, incidentTrend };
  }
}
