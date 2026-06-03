import { Inject, Injectable } from "@nestjs/common";
import type {
  AnomaliesResponse,
  DashboardAnalyticsResponse,
} from "@cmc/contracts";
import { CLICKHOUSE_CLIENT, type ClickHouseClient } from "./clickhouse.client";
import { buildDailyTrend } from "./dashboard-trend";
import { detectAnomalies } from "./anomaly-detector";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_ANALYZE_DAYS = 30;
const DEFAULT_BASELINE_WINDOW = 7;
const DEFAULT_Z = 3;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

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

  /**
   * Realtime anomaly detection (P4.8a / ADR-0066): pull the daily incident
   * series from ClickHouse, gap-fill it (so quiet days count as dips), and run
   * the rolling-baseline Z-score detector. Tenant-scoped in the query; degrades
   * to `unavailable` when ClickHouse is off.
   */
  async anomalies(
    tenantId: string,
    opts: { days?: number; window?: number; zThreshold?: number } = {},
  ): Promise<AnomaliesResponse> {
    const windowDays = clamp(
      Math.trunc(opts.days ?? DEFAULT_ANALYZE_DAYS) || DEFAULT_ANALYZE_DAYS,
      3,
      MAX_WINDOW_DAYS,
    );
    const baselineWindow = clamp(
      Math.trunc(opts.window ?? DEFAULT_BASELINE_WINDOW) ||
        DEFAULT_BASELINE_WINDOW,
      2,
      windowDays - 1,
    );
    const zThreshold =
      opts.zThreshold && opts.zThreshold > 0 ? opts.zThreshold : DEFAULT_Z;

    if (!this.ch.active) {
      return {
        source: "unavailable",
        windowDays,
        baselineWindow,
        zThreshold,
        anomalies: [],
      };
    }
    if (!UUID_RE.test(tenantId)) {
      throw new Error("invalid tenant id");
    }

    const rows = await this.ch.query<{ bucket: string; count: string | number }>(
      `SELECT toString(day) AS bucket, toUInt64(sum(incidents)) AS count
       FROM cmc.incident_daily_stats_by_region
       WHERE tenant_id = '${tenantId}' AND day >= subtractDays(today(), ${windowDays - 1})
       GROUP BY day
       ORDER BY day`,
    );

    const today = new Date().toISOString().slice(0, 10);
    const series = buildDailyTrend(
      rows.map((r) => ({ day: r.bucket, count: Number(r.count) })),
      windowDays,
      today,
    );
    const anomalies = detectAnomalies(
      series.map((p) => ({ bucket: p.day, value: p.count })),
      { window: baselineWindow, zThreshold },
    ).map((a) => ({
      day: a.bucket,
      count: a.value,
      mean: a.mean,
      stddev: a.stddev,
      z: a.z,
      direction: a.direction,
    }));

    return { source: "clickhouse", windowDays, baselineWindow, zThreshold, anomalies };
  }
}
