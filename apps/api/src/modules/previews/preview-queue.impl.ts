import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  PREVIEW_JOB,
  PREVIEW_QUEUE_NAME,
  type PreviewJob,
  type PreviewQueue,
} from "./preview.queue";

/**
 * Real BullMQ preview queue (P2.13 / ADR-0043). Dynamic-imported by the factory
 * only when `PREVIEWS_ENABLED`, so `bullmq` never loads in jest. Owns a dedicated
 * ioredis connection (BullMQ requires `maxRetriesPerRequest: null`).
 */
export class RealPreviewQueue implements PreviewQueue {
  readonly active = true;
  private readonly logger = new Logger("RealPreviewQueue");
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(PREVIEW_QUEUE_NAME, { connection: this.connection });
    this.logger.log(`preview queue ready (${PREVIEW_QUEUE_NAME})`);
  }

  async enqueue(job: PreviewJob): Promise<void> {
    await this.queue.add(
      PREVIEW_JOB,
      job,
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
