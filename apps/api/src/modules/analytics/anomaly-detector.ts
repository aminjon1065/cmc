/**
 * Time-series anomaly detection (P4.8a / ADR-0066) — a pure, deterministic
 * Z-score detector over a rolling baseline. For each point from index `window`
 * onward, it computes the mean + sample stddev of the preceding `window` points
 * and flags the point when |z| ≥ `zThreshold`.
 *
 * `minStddev` is a **floor** on the stddev (not a skip): it stops a flat/quiet
 * baseline from producing an infinite z (and from flagging single-unit noise),
 * while still catching a real jump off that baseline — exactly the "spike out of
 * nowhere" a crisis dashboard cares about. No I/O, no Date → unit-testable.
 */

export type SeriesPoint = { bucket: string; value: number };

export type Anomaly = {
  bucket: string;
  value: number;
  /** Rolling-baseline mean over the preceding `window` points. */
  mean: number;
  /** Rolling-baseline stddev (after the `minStddev` floor). */
  stddev: number;
  /** Standard score (value − mean) / stddev. */
  z: number;
  direction: "spike" | "dip";
};

export type DetectOptions = {
  /** Rolling baseline size (points preceding each candidate). Default 7. */
  window?: number;
  /** |z| threshold to flag. Default 3. */
  zThreshold?: number;
  /** Floor on the baseline stddev. Default 1. */
  minStddev?: number;
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function detectAnomalies(
  series: SeriesPoint[],
  opts: DetectOptions = {},
): Anomaly[] {
  const window = Math.max(Math.trunc(opts.window ?? 7), 2);
  const zThreshold = opts.zThreshold ?? 3;
  const minStddev = Math.max(opts.minStddev ?? 1, 1e-9);

  const out: Anomaly[] = [];
  for (let i = window; i < series.length; i++) {
    const prev = series.slice(i - window, i).map((p) => p.value);
    const mean = prev.reduce((a, b) => a + b, 0) / prev.length;
    const variance =
      prev.reduce((a, b) => a + (b - mean) ** 2, 0) / prev.length;
    const stddev = Math.max(Math.sqrt(variance), minStddev);

    const point = series[i]!;
    const z = (point.value - mean) / stddev;
    if (Math.abs(z) >= zThreshold) {
      out.push({
        bucket: point.bucket,
        value: point.value,
        mean: round(mean),
        stddev: round(stddev),
        z: round(z),
        direction: z >= 0 ? "spike" : "dip",
      });
    }
  }
  return out;
}
