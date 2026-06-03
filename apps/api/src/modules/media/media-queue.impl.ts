import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  MEDIA_JOB,
  MEDIA_QUEUE_NAME,
  type MediaJob,
  type MediaQueue,
} from "./media.queue";

/**
 * Real BullMQ media-transcode queue (P4.5 / ADR-0063). Dynamic-imported by the
 * factory only when `MEDIA_TRANSCODE_ENABLED`, so `bullmq` never loads in jest.
 * Transcodes are long; one retry on transient failure, kept short.
 */
export class RealMediaQueue implements MediaQueue {
  readonly active = true;
  private readonly logger = new Logger("RealMediaQueue");
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(MEDIA_QUEUE_NAME, { connection: this.connection });
    this.logger.log(`media queue ready (${MEDIA_QUEUE_NAME})`);
  }

  async enqueue(job: MediaJob): Promise<void> {
    await this.queue.add(MEDIA_JOB, job, {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
