"use client";

import { useEffect, useState } from "react";
import type { MonitoringEvent } from "@cmc/contracts";
import { getMonitoringReplayAction } from "./actions";

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Time-replay scrubber (P4.3c / ADR-0062). Pick a window, load the audit_log
 * timeline (`/monitoring/replay`), then drag the scrubber (or press Play) to
 * step through events as they happened. Pure client over the polled-data BFF.
 */
export function ReplayPanel() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<MonitoringEvent[]>([]);
  const [pos, setPos] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const n = new Date();
    setTo(toLocalInput(n));
    setFrom(toLocalInput(new Date(n.getTime() - 3_600_000)));
  }, []);

  async function load() {
    if (!from || !to) return;
    setLoading(true);
    setErr(null);
    setPlaying(false);
    const r = await getMonitoringReplayAction(
      new Date(from).toISOString(),
      new Date(to).toISOString(),
    );
    setLoading(false);
    if (!r.ok) {
      setErr(r.error);
      setEvents([]);
      return;
    }
    setEvents(r.data.events);
    setPos(r.data.events.length); // start fully played; drag back to replay
  }

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || events.length === 0) return;
    if (pos >= events.length) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setPos((p) => Math.min(p + 1, events.length)), 400);
    return () => clearTimeout(id);
  }, [playing, pos, events.length]);

  const current = pos > 0 ? events[pos - 1] : null;
  // A sliding window of the most recent ~40 events up to the scrubber.
  const visible = events.slice(Math.max(0, pos - 40), pos);

  return (
    <div className="cmc-card flex flex-col">
      <div className="cmc-card-header flex items-center gap-2">
        <span className="cmc-label">Time replay</span>
        <div className="flex-1" />
        <input
          type="datetime-local"
          className="cmc-input"
          style={{ padding: "1px 6px", fontSize: 11 }}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="text-[10px]" style={{ color: "var(--c-fg-4)" }}>
          →
        </span>
        <input
          type="datetime-local"
          className="cmc-input"
          style={{ padding: "1px 6px", fontSize: 11 }}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button className="cmc-btn" disabled={loading} onClick={() => void load()}>
          {loading ? "…" : "Load"}
        </button>
      </div>

      <div className="flex flex-col gap-2 p-4">
        {err && (
          <div className="text-[11px]" style={{ color: "var(--c-sev-1)" }}>
            {err}
          </div>
        )}

        {events.length === 0 ? (
          <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
            {loading ? "Loading…" : "Load a window to replay its timeline."}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button
                className="cmc-btn"
                style={{ width: 64 }}
                onClick={() => {
                  if (pos >= events.length) setPos(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "❚❚ Pause" : "▶ Play"}
              </button>
              <input
                type="range"
                min={0}
                max={events.length}
                value={pos}
                onChange={(e) => {
                  setPlaying(false);
                  setPos(Number(e.target.value));
                }}
                style={{ flex: 1 }}
              />
              <span
                className="cmc-mono text-[10px]"
                style={{ color: "var(--c-fg-4)", minWidth: 90, textAlign: "right" }}
              >
                {pos}/{events.length}
              </span>
            </div>
            <div
              className="cmc-mono text-[10.5px]"
              style={{ color: "var(--c-accent)" }}
            >
              {current
                ? new Date(current.occurredAt).toLocaleString()
                : "— start —"}
            </div>
            <div
              className="flex flex-col overflow-auto"
              style={{ maxHeight: 240 }}
            >
              {visible.map((e, i) => {
                const isCurrent = i === visible.length - 1;
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-2 px-1 py-1 text-[11px]"
                    style={{
                      background: isCurrent ? "var(--c-bg-3)" : "transparent",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 7,
                        color:
                          e.outcome === "success"
                            ? "var(--c-accent)"
                            : "var(--c-sev-1)",
                      }}
                    >
                      ●
                    </span>
                    <span className="cmc-mono" style={{ color: "var(--c-fg-4)" }}>
                      {new Date(e.occurredAt).toLocaleTimeString()}
                    </span>
                    <span className="truncate" style={{ color: "var(--c-fg-2)" }}>
                      {e.action}
                    </span>
                    <div className="flex-1" />
                    <span style={{ color: "var(--c-fg-4)" }}>
                      {e.resourceType}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
