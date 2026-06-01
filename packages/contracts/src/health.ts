/**
 * Health-check contracts (P0.8 / ADR-0015).
 *
 * Three tiers per ToR §14.8:
 *   - liveness  (`GET /health`)       — "process is alive", never touches deps
 *   - readiness (`GET /health/ready`) — "ready to serve", pings every dep
 *   - deep      (`GET /health/deep`)  — per-dependency status + timings
 */

/** Liveness response — unchanged since the first commit. */
export type HealthCheckResponse = {
  status: "ok";
  version: string;
  uptimeSeconds: number;
  timestamp: string;
};

/** A dependency is either reachable or not. */
export type DependencyStatus = "up" | "down";

/** The set of infrastructure dependencies probed by readiness/deep. */
export type HealthDependencyName = "postgres" | "redis" | "minio";

/** One dependency's result in the readiness probe (status only — lean for LBs). */
export type ReadinessCheck = {
  name: HealthDependencyName;
  status: DependencyStatus;
};

/**
 * Readiness response. `status` is "ready" iff every check is "up".
 * The endpoint returns HTTP 200 when ready, 503 when not — so a load
 * balancer / orchestrator can route on the status code alone.
 */
export type ReadinessResponse = {
  status: "ready" | "not_ready";
  checks: ReadinessCheck[];
  timestamp: string;
};

/** One dependency's detailed report in the deep probe. */
export type DeepDependencyReport = {
  name: HealthDependencyName;
  status: DependencyStatus;
  /** Round-trip latency of the probe in milliseconds. */
  latencyMs: number;
  /** Present only when status is "down" — the probe's error message. */
  error?: string;
};

/**
 * Deep health response (admin/operator diagnostics). `status` is "ok"
 * iff every dependency is "up", else "degraded". Always returns HTTP 200
 * — it is a diagnostic surface, not an LB signal; read the body.
 */
export type DeepHealthResponse = {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  dependencies: DeepDependencyReport[];
};
