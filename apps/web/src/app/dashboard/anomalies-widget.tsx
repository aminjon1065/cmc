"use client";

import { useEffect, useState } from "react";
import type { AnomaliesResponse } from "@cmc/contracts";
import { fetchAnomaliesAction } from "./actions";

/**
 * Realtime anomaly widget (P4.8b / ADR-0066). Renders the server-fetched initial
 * anomalies and polls every 60s (BFF → /v1/analytics/anomalies). Degrades to an
 * "unavailable" note when ClickHouse is off.
 */
export function AnomaliesWidget({
  initial,
}: {
  initial: AnomaliesResponse | null;
}) {
  const [data, setData] = useState<AnomaliesResponse | null>(initial);

  useEffect(() => {
    const id = setInterval(() => {
      void fetchAnomaliesAction().then((next) => {
        if (next) setData(next);
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const available = data?.source === "clickhouse";
  const anomalies = data?.anomalies ?? [];

  return (
    <div className="cmc-card">
      <div className="cmc-card-header">
        <span className="cmc-label">Anomalies · realtime</span>
        <div className="flex-1" />
        <span className="cmc-mono text-[10.5px]" style={{ color: "var(--c-fg-3)" }}>
          {available ? `${anomalies.length} flagged` : "analytics unavailable"}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        {!available ? (
          <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
            Anomaly analytics unavailable.
          </div>
        ) : anomalies.length === 0 ? (
          <div className="text-[11.5px]" style={{ color: "var(--c-fg-4)" }}>
            No anomalies in the recent window.
          </div>
        ) : (
          anomalies
            .slice(-8)
            .reverse()
            .map((a) => (
              <div
                key={`${a.day}-${a.direction}`}
                className="flex items-center gap-2 text-[11.5px]"
              >
                <span
                  className="cmc-chip"
                  style={{
                    color:
                      a.direction === "spike"
                        ? "var(--c-sev-1)"
                        : "var(--c-info)",
                  }}
                >
                  {a.direction === "spike" ? "▲" : "▼"} {a.direction}
                </span>
                <span style={{ color: "var(--c-fg-1)" }}>{a.count}</span>
                <span style={{ color: "var(--c-fg-4)" }}>vs ~{a.mean}</span>
                <div className="flex-1" />
                <span className="cmc-mono" style={{ color: "var(--c-fg-3)" }}>
                  z={a.z} · {a.day}
                </span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
