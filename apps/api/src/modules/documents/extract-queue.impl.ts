import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  EXTRACT_JOB,
  EXTRACT_QUEUE_NAME,
  type ExtractJob,
  type ExtractQueue,
} from "./extract.queue";

/**
 * Real BullMQ extraction queue (P5.6b / ADR-0072). Dynamic-imported by the
 * factory only when `DOC_EXTRACT_ENABLED`, so `bullmq` never loads in jest. Owns
 * a dedicated ioredis connection (BullMQ requires `maxRetriesPerRequest: null`).
 */
export class RealExtractQueue implements ExtractQueue {
  readonly active = true;
  private readonly logger = new Logger("RealExtractQueue");
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(EXTRACT_QUEUE_NAME, { connection: this.connection });
    this.logger.log(`extract queue ready (${EXTRACT_QUEUE_NAME})`);
  }

  async enqueue(job: ExtractJob): Promise<void> {
    await this.queue.add(EXTRACT_JOB, job, {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
