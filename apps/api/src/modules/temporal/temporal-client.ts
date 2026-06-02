import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the Temporal client seam (P3.1 / ADR-0045). */
export const TEMPORAL_CLIENT = Symbol("TEMPORAL_CLIENT");

/** Start a workflow execution. `workflowId` is the dedup key (one per case). */
export interface StartWorkflowInput {
  workflowType: string;
  workflowId: string;
  args: unknown[];
}

/**
 * Minimal, Temporal-agnostic client seam. Domain code (e.g. `CaseSlaScheduler`)
 * depends on this, not on `@temporalio/client`, so the heavy SDK only loads when
 * `TEMPORAL_ENABLED` (and never in jest). `start` is idempotent on `workflowId`
 * (re-starting a still-running id is a no-op); `cancel` of an unknown/closed id
 * is a no-op too.
 */
export interface TemporalClient {
  /** Whether a real Temporal connection is wired vs the noop. */
  readonly active: boolean;
  start(input: StartWorkflowInput): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  close(): Promise<void>;
}

/** No-op client used when Temporal is disabled (dev/test default). */
export class NoopTemporalClient implements TemporalClient {
  readonly active = false;
  async start(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Factory: a real Temporal-backed client when `TEMPORAL_ENABLED`, else a noop.
 * The real impl is dynamic-imported so `@temporalio/client` never enters the jest
 * runtime when Temporal is off (the gated-lazy-seam pattern).
 */
export async function createTemporalClient(
  config: ConfigService<AppConfig, true>,
): Promise<TemporalClient> {
  if (!config.get("TEMPORAL_ENABLED", { infer: true })) {
    return new NoopTemporalClient();
  }
  const { RealTemporalClient } = await import("./temporal-client.impl");
  return RealTemporalClient.create({
    address: config.get("TEMPORAL_ADDRESS", { infer: true }),
    namespace: config.get("TEMPORAL_NAMESPACE", { infer: true }),
    taskQueue: config.get("TEMPORAL_TASK_QUEUE", { infer: true }),
  });
}
