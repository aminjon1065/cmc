import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the document text-extraction job queue (P5.6b / ADR-0072). */
export const EXTRACT_QUEUE = Symbol("EXTRACT_QUEUE");

// BullMQ forbids ":" in queue names (Redis key separator), so use "-".
export const EXTRACT_QUEUE_NAME = "cmc-doc-extract";
export const EXTRACT_JOB = "extract-text";

/** Extract job payload — carries the tenant since the worker has no request. */
export type ExtractJob = { tenantId: string; documentId: string };

export interface ExtractQueue {
  /** Whether a real queue is wired (BullMQ) vs the noop. */
  readonly active: boolean;
  enqueue(job: ExtractJob): Promise<void>;
  close(): Promise<void>;
}

/** No-op queue used when extraction is disabled (dev/test default). */
export class NoopExtractQueue implements ExtractQueue {
  readonly active = false;
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real BullMQ-backed queue when `DOC_EXTRACT_ENABLED`, else a noop.
 * The real impl is dynamic-imported so `bullmq` never enters jest when
 * extraction is off (the gated-lazy-seam pattern, mirroring the preview queue).
 */
export async function createExtractQueue(
  config: ConfigService<AppConfig, true>,
): Promise<ExtractQueue> {
  if (!config.get("DOC_EXTRACT_ENABLED", { infer: true })) {
    return new NoopExtractQueue();
  }
  const { RealExtractQueue } = await import("./extract-queue.impl");
  return new RealExtractQueue(config.get("REDIS_URL", { infer: true }));
}
