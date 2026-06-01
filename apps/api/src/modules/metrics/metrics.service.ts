import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";
import type { AppConfig } from "../../config/configuration";

export type DbTxScope = "tenant" | "privileged";
export type DbTxOutcome = "commit" | "error";

/**
 * Owns the Prometheus metric registry for the API (P0.7 / ADR-0014).
 *
 * Uses `prom-client` directly with a *dedicated* Registry (not the global
 * default one) so that building the Nest app more than once in a single
 * process — which jest does, once per e2e suite — never throws
 * "metric already registered". Every metric is bound to `this.registry`.
 *
 * Metric families:
 *   - HTTP RED: `http_request_duration_seconds` histogram (method, route,
 *     status_code). Prometheus derives rate + error-ratio from its
 *     `_count` by label, and latency quantiles from its buckets — so this
 *     single histogram covers Rate, Errors, and Duration.
 *   - DB saturation: `cmc_db_transactions_in_flight` gauge +
 *     `cmc_db_transactions_total` counter (scope, outcome) +
 *     `cmc_db_pool_max` gauge. Sourced at the single tx chokepoint in
 *     TenantDatabaseService — postgres-js exposes no public live
 *     pool-stat API, so in-flight transactions is the honest saturation
 *     signal (see ADR-0014).
 *   - Node process defaults (event-loop lag, heap, GC, CPU) via
 *     `collectDefaultMetrics`.
 */
@Injectable()
export class MetricsService {
  readonly registry: Registry;
  /** Gate from METRICS_ENABLED — when false every record call is a no-op. */
  private readonly enabled: boolean;

  private readonly httpDuration: Histogram<
    "method" | "route" | "status_code"
  >;
  private readonly dbInFlight: Gauge<string>;
  private readonly dbTxTotal: Counter<"scope" | "outcome">;
  private readonly dbPoolMax: Gauge<string>;

  constructor(config: ConfigService<AppConfig, true>) {
    this.enabled = config.get("METRICS_ENABLED", { infer: true });

    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: "cmc-api" });

    // Node process metrics (process_cpu_*, nodejs_eventloop_lag_*,
    // nodejs_heap_size_*, nodejs_gc_*). Bound to our registry only.
    // Skipped entirely when metrics are disabled.
    if (this.enabled) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency in seconds (RED: rate via _count, errors via status_code, duration via buckets)",
      labelNames: ["method", "route", "status_code"] as const,
      // Tuned for typical API latencies; default prom-client web buckets.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.dbInFlight = new Gauge({
      name: "cmc_db_transactions_in_flight",
      help: "Number of database transactions currently executing through TenantDatabaseService",
      registers: [this.registry],
    });

    this.dbTxTotal = new Counter({
      name: "cmc_db_transactions_total",
      help: "Total database transactions by scope and outcome",
      labelNames: ["scope", "outcome"] as const,
      registers: [this.registry],
    });

    this.dbPoolMax = new Gauge({
      name: "cmc_db_pool_max",
      help: "Configured maximum size of the Postgres connection pool",
      registers: [this.registry],
    });
  }

  // ---------- HTTP ----------

  observeHttp(params: {
    method: string;
    route: string;
    statusCode: number;
    durationSec: number;
  }): void {
    if (!this.enabled) return;
    this.httpDuration.observe(
      {
        method: params.method,
        route: params.route,
        status_code: String(params.statusCode),
      },
      params.durationSec,
    );
  }

  // ---------- DB ----------

  /** Call when a DB transaction starts (chokepoint: TenantDatabaseService). */
  dbTxStart(): void {
    if (!this.enabled) return;
    this.dbInFlight.inc();
  }

  /** Call when a DB transaction settles. */
  dbTxEnd(scope: DbTxScope, outcome: DbTxOutcome): void {
    if (!this.enabled) return;
    this.dbInFlight.dec();
    this.dbTxTotal.inc({ scope, outcome });
  }

  /** Set once at boot from the configured pool max. */
  setDbPoolMax(max: number): void {
    if (!this.enabled) return;
    this.dbPoolMax.set(max);
  }

  // ---------- exposition ----------

  contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
