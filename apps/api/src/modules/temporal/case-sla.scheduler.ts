import { Inject, Injectable, Logger } from "@nestjs/common";
import { TEMPORAL_CLIENT, type TemporalClient } from "./temporal-client";

/**
 * Case SLA scheduling policy (P3.1 / ADR-0045). Translates case lifecycle into
 * Temporal workflow operations, keeping Temporal specifics out of CasesService.
 * Depends only on the gated {@link TemporalClient} seam, so with Temporal off
 * (default) every call is a cheap noop. Wired into the case lifecycle in P3.1b.
 */
@Injectable()
export class CaseSlaScheduler {
  private readonly logger = new Logger(CaseSlaScheduler.name);

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly temporal: TemporalClient,
  ) {}

  /** Deterministic, one-per-case workflow id (→ start is idempotent). */
  static workflowId(caseId: string): string {
    return `case-sla:${caseId}`;
  }

  /** Start (or keep) the SLA timer for a case due at `dueAtIso`. */
  async schedule(
    tenantId: string,
    caseId: string,
    dueAtIso: string,
  ): Promise<void> {
    await this.temporal.start({
      workflowType: "caseSlaWorkflow",
      workflowId: CaseSlaScheduler.workflowId(caseId),
      args: [{ tenantId, caseId, dueAtIso }],
    });
    if (this.temporal.active) {
      this.logger.debug(`scheduled SLA timer for case ${caseId} @ ${dueAtIso}`);
    }
  }

  /** Cancel the SLA timer for a case (resolved/closed/cleared SLA). */
  async cancel(caseId: string): Promise<void> {
    await this.temporal.cancel(CaseSlaScheduler.workflowId(caseId));
  }
}
