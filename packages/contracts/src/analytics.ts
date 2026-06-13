import { z } from "zod";

/**
 * Dashboard analytics (ToR v2.0 §5): operational trends computed from
 * **PostgreSQL** — historical series the OLTP snapshot (`/incidents/stats`)
 * deliberately doesn't compute. ClickHouse + the realtime-anomaly plane were
 * removed in ADR-0080.
 */

/** One day's incident count in a trend series. `day` is `YYYY-MM-DD` (UTC). */
export const DashboardTrendPointSchema = z.object({
  day: z.string(),
  count: z.number().int().nonnegative(),
});
export type DashboardTrendPoint = z.infer<typeof DashboardTrendPointSchema>;

export const DashboardAnalyticsResponseSchema = z.object({
  /** Always `postgres` — the analytics source of record. */
  source: z.literal("postgres"),
  /** Length of the trend window in days (continuous, gap-filled). */
  windowDays: z.number().int().positive(),
  /** Daily incident counts over the window, oldest → newest. */
  incidentTrend: z.array(DashboardTrendPointSchema),
});
export type DashboardAnalyticsResponse = z.infer<
  typeof DashboardAnalyticsResponseSchema
>;
