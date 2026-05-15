import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export function KPI({
  label,
  value,
  delta,
  trend,
  accent,
  sparkData,
}: {
  label: string;
  value: string;
  delta?: string;
  trend?: "up" | "down";
  accent?: string;
  sparkData?: number[];
}) {
  return (
    <div className="cmc-card flex flex-col gap-2 p-3">
      <div className="cmc-label">{label}</div>
      <div className="flex items-baseline gap-2">
        <span
          className="cmc-display text-[26px] font-semibold leading-none"
          style={{ color: accent ?? "var(--c-fg-1)", letterSpacing: "-0.015em" }}
        >
          {value}
        </span>
        {delta && (
          <span
            className="flex items-center gap-0.5 text-[10.5px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {trend === "up" && (
              <ArrowUpRight size={10} strokeWidth={2} />
            )}
            {trend === "down" && (
              <ArrowDownRight size={10} strokeWidth={2} />
            )}
            {delta}
          </span>
        )}
      </div>
      {sparkData && <Sparkline data={sparkData} color={accent ?? "var(--c-accent)"} />}
    </div>
  );
}

function Sparkline({
  data,
  color,
  width = 120,
  height = 28,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - ((v - min) / range) * (height - 4) - 2,
  ]);
  const path = pts
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ");
  const fillPath = `${path} L${width},${height} L0,${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      <path d={fillPath} fill={color} opacity={0.15} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}
