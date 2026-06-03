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

/**
 * Realtime analytics — anomaly detection (P4.8 / ADR-0066). A rolling-baseline
 * Z-score flags incident-volume days that deviate from the recent norm.
 */
export const AnomalyPointSchema = z.object({
  /** Day of the anomalous point, `YYYY-MM-DD` (UTC). */
  day: z.string(),
  /** The day's incident count. */
  count: z.number().int().nonnegative(),
  /** Rolling-baseline mean over the preceding window. */
  mean: z.number(),
  /** Rolling-baseline stddev (floored). */
  stddev: z.number(),
  /** Standard score. */
  z: z.number(),
  direction: z.enum(["spike", "dip"]),
});
export type AnomalyPoint = z.infer<typeof AnomalyPointSchema>;

export const AnomaliesResponseSchema = z.object({
  source: z.enum(["clickhouse", "unavailable"]),
  /** Total days analysed (the gap-filled series length). */
  windowDays: z.number().int().positive(),
  /** Rolling baseline size (points preceding each candidate). */
  baselineWindow: z.number().int().positive(),
  /** |z| threshold used to flag. */
  zThreshold: z.number(),
  /** Anomalous days, oldest → newest. */
  anomalies: z.array(AnomalyPointSchema),
});
export type AnomaliesResponse = z.infer<typeof AnomaliesResponseSchema>;
