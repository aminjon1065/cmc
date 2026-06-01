import { Controller, Get, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type {
  DeepHealthResponse,
  HealthCheckResponse,
  ReadinessResponse,
} from "@cmc/contracts";
import { HealthService } from "./health.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

const startedAt = Date.now();

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness (P0.8 / ADR-0015). "The process is up and the event loop is
   * turning." Never touches a dependency — a liveness probe that fails on
   * a DB blip would make an orchestrator kill a recoverable pod. Always
   * 200 while the process can answer.
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

  /**
   * Readiness. Pings Postgres + Redis + MinIO in parallel. Returns 200
   * when every dependency is reachable, 503 otherwise — so a load
   * balancer / orchestrator routes on the status code alone. Anonymous:
   * probes carry no tenant data and infra needs to reach it without a
   * token.
   */
  @Get("ready")
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessResponse> {
    const result = await this.health.checkReadiness();
    res.status(result.status === "ready" ? 200 : 503);
    return result;
  }

  /**
   * Deep diagnostics: per-dependency status + latency + error. Always
   * 200 (it is a diagnostic surface — read the body, don't route on it).
   *
   * Gated by JwtAuthGuard: it exposes internal dependency timings and
   * error strings, so it requires an authenticated caller. True
   * role-restriction to platform/tenant admins lands with RBAC (P1.1);
   * until roles exist, "authenticated" is the available boundary —
   * documented in ADR-0015.
   */
  @Get("deep")
  @UseGuards(JwtAuthGuard)
  async deep(): Promise<DeepHealthResponse> {
    return this.health.checkDeep();
  }
}
