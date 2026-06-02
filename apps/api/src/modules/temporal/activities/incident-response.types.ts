/**
 * Activity signatures for the incident-response workflow (P3.2 / ADR-0046).
 * TYPE-ONLY (imported by the determinism-safe workflow via `import type`); the
 * worker supplies an implementation (`buildIncidentResponseActivities`).
 */
export type ResponsePhase = "page" | "reminder";

export interface IncidentResponseActivities {
  /** Current incident status, or "missing" if gone/soft-deleted. */
  loadIncidentStatus(tenantId: string, incidentId: string): Promise<string>;
  /**
   * Notify the responders (assignee + reporter) — the initial page or a
   * reminder. No-op if the incident is no longer unacknowledged.
   */
  notifyResponders(
    tenantId: string,
    incidentId: string,
    phase: ResponsePhase,
  ): Promise<void>;
  /**
   * Escalate an unacknowledged incident: notify `incident:resolve` holders and
   * emit an `incident.escalated` event. Idempotent / safe to retry.
   */
  escalateIncident(tenantId: string, incidentId: string): Promise<void>;
}
