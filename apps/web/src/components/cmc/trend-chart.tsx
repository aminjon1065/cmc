import type { DashboardTrendPoint } from "@cmc/contracts";

/**
 * A compact daily bar chart for the dashboard incident trend (P2.6 / ADR-0036).
 * One bar per day; height scales to the window max. Zero-days render as a faint
 * sliver so the cadence stays readable. Each bar carries a `day: count` tooltip.
 */
export function TrendChart({
  data,
  color = "var(--c-info)",
  height = 56,
}: {
  data: DashboardTrendPoint[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {data.map((d) => {
        const pct = Math.round((d.count / max) * 100);
        return (
          <div
            key={d.day}
            className="flex-1 rounded-sm transition-[height]"
            title={`${d.day}: ${d.count} incident${d.count === 1 ? "" : "s"}`}
            style={{
              height: `${d.count > 0 ? Math.max(pct, 8) : 3}%`,
              minHeight: 2,
              background: d.count > 0 ? color : "var(--c-bg-3)",
            }}
          />
        );
      })}
    </div>
  );
}
