import { z } from "zod";

/**
 * Dashboard analytics (P2.6 / ADR-0036): ClickHouse-backed metrics the OLTP
 * snapshot (`/incidents/stats`) deliberately doesn't compute — historical
 * trends served from the analytics plane (P2.5).
 */

/** One day's incident count in a trend series. `day` is `YYYY-MM-DD` (UTC). */
export const DashboardTrendPointSchema = z.object({
  day: z.string(),
  count: z.number().int().nonnegative(),
});
export type DashboardTrendPoint = z.infer<typeof DashboardTrendPointSchema>;

export const DashboardAnalyticsResponseSchema = z.object({
  /**
   * `clickhouse` when served live from the analytics store; `unavailable` when
   * ClickHouse is disabled/unreachable (the UI degrades gracefully).
   */
  source: z.enum(["clickhouse", "unavailable"]),
  /** Length of the trend window in days (continuous, gap-filled). */
  windowDays: z.number().int().positive(),
  /** Daily incident-created counts over the window, oldest → newest. */
  incidentTrend: z.array(DashboardTrendPointSchema),
});
export type DashboardAnalyticsResponse = z.infer<
  typeof DashboardAnalyticsResponseSchema
>;
