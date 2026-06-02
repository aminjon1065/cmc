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
import { PreviewService } from "./preview.service";
import { PREVIEW_QUEUE_NAME, type PreviewJob } from "./preview.queue";

/**
 * BullMQ preview worker (P2.13b / ADR-0043). Consumes the preview queue and runs
 * {@link PreviewService.generatePreview}. Gated on `PREVIEWS_ENABLED` + skipped
 * in tests; `bullmq`/`ioredis` are dynamic-imported so they never enter jest.
 */
@Injectable()
export class PreviewWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewWorker.name);
  private readonly enabled: boolean;
  private readonly isTest: boolean;
  private readonly redisUrl: string;
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private readonly previews: PreviewService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("PREVIEWS_ENABLED", { infer: true });
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
      PREVIEW_QUEUE_NAME,
      async (job) => {
        const { tenantId, documentId } = job.data as PreviewJob;
        await this.previews.generatePreview(tenantId, documentId);
      },
      { connection: this.connection },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`preview job ${job?.id ?? "?"} failed: ${err.message}`),
    );
    this.logger.log(`preview worker consuming ${PREVIEW_QUEUE_NAME}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    this.connection?.disconnect();
  }
}
