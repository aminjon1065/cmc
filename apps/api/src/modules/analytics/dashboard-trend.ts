import type { DashboardTrendPoint } from "@cmc/contracts";

/**
 * Fill a sparse set of daily counts into a continuous `days`-long window ending
 * on `today` (UTC, `YYYY-MM-DD`), so the trend has no gaps — days with no data
 * become `0`, oldest → newest (P2.6 / ADR-0036). Pure + deterministic: `today`
 * is injected rather than read from the clock, so it's trivially testable.
 */
export function buildDailyTrend(
  rows: DashboardTrendPoint[],
  days: number,
  today: string,
): DashboardTrendPoint[] {
  const counts = new Map(rows.map((r) => [r.day, r.count]));
  const base = Date.parse(`${today}T00:00:00Z`);
  const out: DashboardTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  return out;
}
