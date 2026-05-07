import { Controller, Get } from "@nestjs/common";
import type { HealthCheckResponse } from "@cmc/contracts";

const startedAt = Date.now();

@Controller("health")
export class HealthController {
  /**
   * Lightweight liveness/readiness endpoint. As dependencies are added
   * (Postgres, Redis, MinIO), they should be checked here so a single probe
   * gives a definitive answer about whether the API can serve traffic.
   */
  @Get()
  check(): HealthCheckResponse {
    return {
      status: "ok",
      version: process.env.npm_package_version ?? "0.0.0",
      uptimeSeconds: (Date.now() - startedAt) / 1000,
      timestamp: new Date().toISOString(),
    };
  }
}
