export function PercentBar({
  value,
  max = 100,
  color = "var(--c-accent)",
  height = 4,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className="w-full overflow-hidden rounded-sm"
      style={{ height, background: "var(--c-bg-3)" }}
    >
      <div
        className="h-full rounded-sm"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}
