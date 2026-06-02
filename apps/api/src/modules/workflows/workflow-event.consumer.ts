import { Injectable, Logger } from "@nestjs/common";
import type { EventEnvelope } from "@cmc/contracts";
import { EventDedupService } from "../events/event-dedup.service";
import { WorkflowsService } from "./workflows.service";

/** Idempotency-ledger consumer name. */
const CONSUMER = "workflow-trigger";

/**
 * Event-triggered workflow auto-start (P3.8c / ADR-0053). Reacts to any domain
 * event on the bus: if the tenant has enabled, event-triggered workflows bound
 * to `${aggregateType}.${eventType}`, it starts a run of each with the event
 * payload as input. `handle()` is the pure, testable unit (tests call it
 * directly); the subscriber drives it from a durable JetStream consumer.
 *
 * Dedup is claimed only once a match exists, so the common no-match event
 * doesn't write a ledger row. At-least-once → a redelivery re-queries (cheap)
 * and the claim makes the actual start idempotent.
 */
@Injectable()
export class WorkflowEventConsumer {
  private readonly logger = new Logger(WorkflowEventConsumer.name);

  constructor(
    private readonly workflows: WorkflowsService,
    private readonly dedup: EventDedupService,
  ) {}

  async handle(env: EventEnvelope): Promise<void> {
    if (!env.tenantId) return;
    const token = `${env.aggregateType}.${env.eventType}`;
    const matches = await this.workflows.findEnabledEventWorkflows(
      env.tenantId,
      token,
    );
    if (matches.length === 0) return;

    if (!(await this.dedup.claim(env.id, CONSUMER))) return; // redelivery → skip
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    for (const wf of matches) {
      await this.workflows.startTriggeredRun(env.tenantId, wf, payload);
    }
    this.logger.log(
      `event ${token} (${env.id}) started ${matches.length} workflow(s)`,
    );
  }
}
