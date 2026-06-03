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
import { MediaService } from "./media.service";
import { MEDIA_QUEUE_NAME, type MediaJob } from "./media.queue";

/**
 * BullMQ media-transcode worker (P4.5 / ADR-0063). Consumes the queue and runs
 * {@link MediaService.transcode} (ffmpeg → HLS → S3). Gated on
 * `MEDIA_TRANSCODE_ENABLED` + skipped in tests; `bullmq`/`ioredis` (and ffmpeg,
 * inside the service) are dynamic-imported so they never enter jest.
 */
@Injectable()
export class MediaWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaWorker.name);
  private readonly enabled: boolean;
  private readonly isTest: boolean;
  private readonly redisUrl: string;
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private readonly media: MediaService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("MEDIA_TRANSCODE_ENABLED", { infer: true });
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
      MEDIA_QUEUE_NAME,
      async (job) => {
        const { tenantId, assetId } = job.data as MediaJob;
        await this.media.transcode(tenantId, assetId);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`media job ${job?.id ?? "?"} failed: ${err.message}`),
    );
    this.logger.log(`media worker consuming ${MEDIA_QUEUE_NAME}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    this.connection?.disconnect();
  }
}
