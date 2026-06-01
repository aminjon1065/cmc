import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import type { Database } from "@cmc/db";
import type {
  DeepDependencyReport,
  DeepHealthResponse,
  HealthDependencyName,
  ReadinessResponse,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { DB } from "../database/database.tokens";
import { REDIS } from "../redis/redis.tokens";
import { StorageService } from "../storage/storage.service";

const startedAt = Date.now();

/** Internal probe result before it's shaped into a response. */
type ProbeResult = {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
};

/**
 * Dependency health probes for the readiness + deep endpoints
 * (P0.8 / ADR-0015).
 *
 * Each probe is bounded by `HEALTH_PROBE_TIMEOUT_MS` so a hung
 * dependency can never hang the probe endpoint (which would, in turn,
 * make an orchestrator think the whole API is wedged). Probes run in
 * parallel — total latency is the slowest single probe, not their sum.
 *
 * The probes use the raw clients (postgres-js client, ioredis, S3Client),
 * NOT the tenant-scoped transaction wrapper — a readiness check is a pure
 * connectivity test and must not depend on request/tenant context.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeoutMs: number;
  private readonly filesBucket: string;

  constructor(
    @Inject(DB) private readonly database: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly storage: StorageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.timeoutMs = config.get("HEALTH_PROBE_TIMEOUT_MS", { infer: true });
    this.filesBucket = config.get("S3_BUCKET_FILES", { infer: true });
  }

  // ---------- public API ----------

  /** Lean readiness: status per dependency, no timings/errors. */
  async checkReadiness(): Promise<ReadinessResponse> {
    const results = await this.runAllProbes();
    const checks = results.map((r) => ({ name: r.name, status: r.status }));
    const ready = checks.every((c) => c.status === "up");
    return {
      status: ready ? "ready" : "not_ready",
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  /** Deep diagnostics: per-dependency status + latency + error. */
  async checkDeep(): Promise<DeepHealthResponse> {
    const dependencies = await this.runAllProbes();
    const ok = dependencies.every((d) => d.status === "up");
    return {
      status: ok ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.0.0",
      uptimeSeconds: (Date.now() - startedAt) / 1000,
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  // ---------- probes ----------

  private async runAllProbes(): Promise<DeepDependencyReport[]> {
    const [postgres, redis, minio] = await Promise.all([
      this.timed("postgres", () => this.probePostgres()),
      this.timed("redis", () => this.probeRedis()),
      this.timed("minio", () => this.probeMinio()),
    ]);
    return [postgres, redis, minio];
  }

  private async probePostgres(): Promise<void> {
    // Raw postgres-js tagged template — a pure connectivity check that
    // bypasses RLS / tenant scope. Throws on any connection error.
    await this.database.client`select 1`;
  }

  private async probeRedis(): Promise<void> {
    const pong = await this.redis.ping();
    if (pong !== "PONG") {
      throw new Error(`unexpected PING reply: ${pong}`);
    }
  }

  private async probeMinio(): Promise<void> {
    await this.storage.probeReachable(this.filesBucket);
  }

  // ---------- timing + timeout wrapper ----------

  private async timed(
    name: HealthDependencyName,
    fn: () => Promise<void>,
  ): Promise<DeepDependencyReport> {
    const start = process.hrtime.bigint();
    try {
      await this.withTimeout(fn(), name);
      return {
        name,
        status: "up",
        latencyMs: this.elapsedMs(start),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`health probe '${name}' failed: ${message}`);
      return {
        name,
        status: "down",
        latencyMs: this.elapsedMs(start),
        error: message,
      };
    }
  }

  private withTimeout(p: Promise<void>, name: string): Promise<void> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probe timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<void>;
  }

  private elapsedMs(startNs: bigint): number {
    return Math.round(Number(process.hrtime.bigint() - startNs) / 1e6);
  }
}
