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
import { DocumentExtractionService } from "./document-extraction.service";
import { EXTRACT_QUEUE_NAME, type ExtractJob } from "./extract.queue";

/**
 * BullMQ extraction worker (P5.6b / ADR-0072). Consumes the extract queue and
 * runs {@link DocumentExtractionService.extract} (which stores the text + best-
 * effort re-indexes OpenSearch/vector). Gated on `DOC_EXTRACT_ENABLED` + skipped
 * in tests; `bullmq`/`ioredis` are dynamic-imported so they never enter jest.
 */
@Injectable()
export class ExtractWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtractWorker.name);
  private readonly enabled: boolean;
  private readonly isTest: boolean;
  private readonly redisUrl: string;
  private worker: Worker | null = null;
  private connection: Redis | null = null;

  constructor(
    private readonly extraction: DocumentExtractionService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("DOC_EXTRACT_ENABLED", { infer: true });
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
      EXTRACT_QUEUE_NAME,
      async (job) => {
        const { tenantId, documentId } = job.data as ExtractJob;
        await this.extraction.extract(tenantId, documentId);
      },
      { connection: this.connection },
    );
    this.worker.on("failed", (job, err) =>
      this.logger.warn(`extract job ${job?.id ?? "?"} failed: ${err.message}`),
    );
    this.logger.log(`extract worker consuming ${EXTRACT_QUEUE_NAME}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
    this.connection?.disconnect();
  }
}
