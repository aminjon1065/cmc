import { Inject, Injectable } from "@nestjs/common";
import type { EventEnvelope } from "@cmc/contracts";
import { EventDedupService } from "../events/event-dedup.service";
import { CLICKHOUSE_CLIENT, type ClickHouseClient } from "./clickhouse.client";

const CONSUMER = "incident-projection";
const HANDLED = new Set(["created", "transitioned"]);

/**
 * Projects incident events into ClickHouse (P2.5 / ADR-0033) — the second
 * durable consumer, reusing the P2.4 pattern (handler + dedup). One row per
 * event into `incident_events`; the `incident_daily_stats_by_region` MV rolls up
 * `created` events. `handle()` is the pure, idempotent unit of work; the NATS
 * subscription drives it (P2.5b). Skips when ClickHouse is off.
 */
@Injectable()
export class IncidentProjectionConsumer {
  constructor(
    @Inject(CLICKHOUSE_CLIENT) private readonly ch: ClickHouseClient,
    private readonly dedup: EventDedupService,
  ) {}

  /** ISO `2026-06-01T10:00:00.000Z` → CH `2026-06-01 10:00:00.000` (UTC). */
  private toChDateTime(iso: string): string {
    return iso.slice(0, 23).replace("T", " ");
  }

  async handle(env: EventEnvelope): Promise<void> {
    if (env.aggregateType !== "incident" || !HANDLED.has(env.eventType)) return;
    if (!env.tenantId || !this.ch.active) return;

    if (!(await this.dedup.claim(env.id, CONSUMER))) return;

    const p = env.payload as {
      severity?: number;
      region?: string;
      type?: string;
      status?: string;
      to?: string;
      occurredAt?: string;
    };
    await this.ch.insert("incident_events", [
      {
        event_id: env.id,
        tenant_id: env.tenantId,
        incident_id: env.aggregateId,
        event_type: env.eventType,
        severity: p.severity ?? 0,
        region: p.region ?? "",
        type: p.type ?? "",
        status:
          env.eventType === "created" ? (p.status ?? "reported") : (p.to ?? ""),
        // Prefer the incident's real-world occurrence time (in the `created`
        // payload) over the event-emission time, so the daily-by-region rollup
        // buckets by when the incident happened.
        occurred_at: this.toChDateTime(p.occurredAt ?? env.occurredAt),
      },
    ]);
  }
}
