import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the bulk-import job queue (P3.11 / ADR-0056). */
export const IMPORT_QUEUE = Symbol("IMPORT_QUEUE");

// BullMQ forbids ":" in queue names (it's the Redis key separator), so use "-".
export const IMPORT_QUEUE_NAME = "cmc-imports";
export const IMPORT_JOB = "run-import";

/** Import job payload — carries the tenant since the worker has no request. */
export type ImportQueueJob = { tenantId: string; jobId: string };

export interface ImportQueue {
  /** Whether a real queue is wired (BullMQ) vs the noop. */
  readonly active: boolean;
  enqueue(job: ImportQueueJob): Promise<void>;
  close(): Promise<void>;
}

/** No-op queue used when imports are disabled (dev/test default). */
export class NoopImportQueue implements ImportQueue {
  readonly active = false;
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real BullMQ-backed queue when `IMPORTS_ENABLED`, else a noop. The
 * real impl is dynamic-imported so `bullmq` never enters the jest runtime when
 * imports are off (the gated-lazy-seam pattern, like previews/NATS/ClickHouse).
 */
export async function createImportQueue(
  config: ConfigService<AppConfig, true>,
): Promise<ImportQueue> {
  if (!config.get("IMPORTS_ENABLED", { infer: true })) {
    return new NoopImportQueue();
  }
  const { RealImportQueue } = await import("./import-queue.impl");
  return new RealImportQueue(config.get("REDIS_URL", { infer: true }));
}
