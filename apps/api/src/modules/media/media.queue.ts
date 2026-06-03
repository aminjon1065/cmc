import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the media-transcode job queue (P4.5 / ADR-0063). */
export const MEDIA_QUEUE = Symbol("MEDIA_QUEUE");

// BullMQ forbids ":" in queue names (Redis key separator) — use "-".
export const MEDIA_QUEUE_NAME = "cmc-media-transcode";
export const MEDIA_JOB = "transcode";

/** Media job payload — carries the tenant since the worker has no request. */
export type MediaJob = { tenantId: string; assetId: string };

export interface MediaQueue {
  /** Whether a real BullMQ queue is wired vs the noop. */
  readonly active: boolean;
  enqueue(job: MediaJob): Promise<void>;
  close(): Promise<void>;
}

/** No-op queue when transcoding is disabled (dev/test default). */
export class NoopMediaQueue implements MediaQueue {
  readonly active = false;
  async enqueue(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real BullMQ queue when `MEDIA_TRANSCODE_ENABLED`, else a noop. The
 * real impl is dynamic-imported so `bullmq` never enters the jest runtime when
 * media transcoding is off (gated-lazy-seam, like previews/imports).
 */
export async function createMediaQueue(
  config: ConfigService<AppConfig, true>,
): Promise<MediaQueue> {
  if (!config.get("MEDIA_TRANSCODE_ENABLED", { infer: true })) {
    return new NoopMediaQueue();
  }
  const { RealMediaQueue } = await import("./media-queue.impl");
  return new RealMediaQueue(config.get("REDIS_URL", { infer: true }));
}
