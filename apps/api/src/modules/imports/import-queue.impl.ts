import { Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  IMPORT_JOB,
  IMPORT_QUEUE_NAME,
  type ImportQueue,
  type ImportQueueJob,
} from "./import.queue";

/**
 * Real BullMQ import queue (P3.11 / ADR-0056). Dynamic-imported by the factory
 * only when `IMPORTS_ENABLED`, so `bullmq` never loads in jest. Owns a dedicated
 * ioredis connection (BullMQ requires `maxRetriesPerRequest: null`).
 */
export class RealImportQueue implements ImportQueue {
  readonly active = true;
  private readonly logger = new Logger("RealImportQueue");
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(IMPORT_QUEUE_NAME, { connection: this.connection });
    this.logger.log(`import queue ready (${IMPORT_QUEUE_NAME})`);
  }

  async enqueue(job: ImportQueueJob): Promise<void> {
    // attempts: 3 — retries cover the enqueue-before-commit race (the row may
    // not be visible to the worker's connection on the first try). Double-insert
    // is prevented by the service's compare-and-set claim (queued→processing),
    // NOT by the retry count.
    await this.queue.add(IMPORT_JOB, job, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1500 },
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
