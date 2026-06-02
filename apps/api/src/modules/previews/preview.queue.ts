import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the preview job queue (P2.13 / ADR-0043). */
export const PREVIEW_QUEUE = Symbol("PREVIEW_QUEUE");

// BullMQ forbids ":" in queue names (it's the Redis key separator), so use "-".
export const PREVIEW_QUEUE_NAME = "cmc-previews";
export const PREVIEW_JOB = "generate-preview";

/** Preview job payload — carries the tenant since the worker has no request. */
export type PreviewJob = { tenantId: string; documentId: string };

export interface PreviewQueue {
  /** Whether a real queue is wired (BullMQ) vs the noop. */
  readonly active: boolean;
  enqueue(job: PreviewJob): Promise<void>;
  close(): Promise<void>;
}

/** No-op queue used when previews are disabled (dev/test default). */
export class NoopPreviewQueue implements PreviewQueue {
  readonly active = false;
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real BullMQ-backed queue when `PREVIEWS_ENABLED`, else a noop. The
 * real impl is dynamic-imported so `bullmq` never enters the jest runtime when
 * previews are off (the gated-lazy-seam pattern, like NATS/ClickHouse).
 */
export async function createPreviewQueue(
  config: ConfigService<AppConfig, true>,
): Promise<PreviewQueue> {
  if (!config.get("PREVIEWS_ENABLED", { infer: true })) {
    return new NoopPreviewQueue();
  }
  const { RealPreviewQueue } = await import("./preview-queue.impl");
  return new RealPreviewQueue(config.get("REDIS_URL", { infer: true }));
}
