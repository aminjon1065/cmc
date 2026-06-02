/**
 * Activity signatures for the case-SLA workflow (P3.1 / ADR-0045).
 *
 * This file is TYPE-ONLY on purpose: the workflow imports it with `import type`
 * (so it's erased from the determinism-safe workflow bundle), while the worker
 * supplies an implementation (`buildCaseSlaActivities`) that reaches the DB. The
 * split keeps DB/Node code out of the sandboxed workflow.
 */
export interface CaseSlaActivities {
  /** Current lifecycle status of the case, or "missing" if gone/soft-deleted. */
  loadCaseStatus(tenantId: string, caseId: string): Promise<string>;
  /**
   * Escalate an SLA-breached case: write an `sla_breached` case_activity row and
   * emit a `case.sla_breached` domain event. Idempotent — safe to retry.
   */
  escalateCase(tenantId: string, caseId: string): Promise<void>;
}
