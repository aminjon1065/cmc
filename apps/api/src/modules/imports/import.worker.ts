import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { AppConfig } from "../../config/configuration";
import { ImportService } from "./import.service";
import { IMPORT_QUEUE_NAME, type ImportQueueJob } from "./import.queue";

/**
 * BullMQ import worker (P3.11 / ADR-0056). Consumes the import queue and runs
 * {@link ImportService.runJob}. Gated on `IMPORTS_ENABLED` + skipped in tests;
 * `bullmq`/`ioredis` are dynamic-imported so they never enter jest. Tests drive
 * `runJob` directly instead.
 */
@Injectable()
export class ImportWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportWorker.name);
  private readonly enabled: boolean;
  private readonly isTest: boolean;
  private readonly redisUrl: string;
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private readonly imports: ImportService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("IMPORTS_ENABLED", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
    this.redisUrl = config.get("REDIS_URL", { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { Worker } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;
    this.connection = new IORedis(this.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker(
      IMPORT_QUEUE_NAME,
      async (job) => {
        const { tenantId, jobId } = job.data as ImportQueueJob;
        await this.imports.runJob(tenantId, jobId);
      },
      { connection: this.connection },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`import job ${job?.id ?? "?"} failed: ${err.message}`),
    );
    this.logger.log(`import worker consuming ${IMPORT_QUEUE_NAME}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    this.connection?.disconnect();
  }
}
