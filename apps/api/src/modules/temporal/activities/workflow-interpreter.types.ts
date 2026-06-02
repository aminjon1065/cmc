/**
 * Activity signatures for the visual-workflow interpreter (P3.8b / ADR-0053).
 * Self-contained + TYPE-ONLY (the determinism-safe interpreter workflow imports
 * it via `import type`; no `@cmc/contracts` runtime here). The worker supplies
 * the implementation (`buildWorkflowInterpreterActivities`).
 */
export type WorkflowRunStatusValue =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface NotifyNodeConfig {
  title: string;
  body: string;
  toUserId?: string;
}

export interface CreateIncidentNodeConfig {
  severity: number;
  type: string;
  region: string;
  summary: string;
}

export interface WorkflowInterpreterActivities {
  /** Drive the `workflow_runs` row's status (+ output/error on terminal). */
  markRunStatus(
    tenantId: string,
    runId: string,
    status: WorkflowRunStatusValue,
    extra?: { output?: Record<string, unknown>; error?: string },
  ): Promise<void>;
  /** Notify a user; recipient = `cfg.toUserId` or the run initiator fallback. */
  executeNotify(
    tenantId: string,
    runId: string,
    cfg: NotifyNodeConfig,
    fallbackUserId: string | null,
  ): Promise<void>;
  /** Create an incident from a node's config; returns the new incident id. */
  executeCreateIncident(
    tenantId: string,
    cfg: CreateIncidentNodeConfig,
    startedBy: string | null,
  ): Promise<string>;
}
