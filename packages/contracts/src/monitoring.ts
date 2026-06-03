import { z } from "zod";

/**
 * Operational Monitoring Center (P4.3 / ADR-0062). A command-center "wall":
 * `GET /v1/monitoring/summary` is a server-aggregated live snapshot the browser
 * polls; `GET /v1/monitoring/replay` returns the operational action timeline
 * (from `audit_log`) over a window for time-replay. Both gated on `monitoring:read`,
 * tenant-scoped via RLS.
 */

/** One entry of the operational timeline (an audit_log row, ops-facing subset). */
export const MonitoringEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  actorId: z.string().uuid().nullable(),
  outcome: z.string(),
});
export type MonitoringEvent = z.infer<typeof MonitoringEventSchema>;

export const MonitoringRecentIncidentSchema = z.object({
  id: z.string().uuid(),
  summary: z.string(),
  severity: z.number().int(),
  status: z.string(),
  createdAt: z.string().datetime(),
});
export type MonitoringRecentIncident = z.infer<
  typeof MonitoringRecentIncidentSchema
>;

export const MonitoringSummarySchema = z.object({
  generatedAt: z.string().datetime(),
  incidents: z.object({
    /** Count of non-terminal, non-deleted incidents (not resolved/closed/cancelled). */
    active: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    bySeverity: z.record(z.string(), z.number().int()),
  }),
  recentIncidents: z.array(MonitoringRecentIncidentSchema),
  /** Newest-first operational events for the alert ticker. */
  recentEvents: z.array(MonitoringEventSchema),
  /** Open video rooms (live coordination calls). */
  videoRoomsOpen: z.number().int(),
});
export type MonitoringSummary = z.infer<typeof MonitoringSummarySchema>;

export const MonitoringSummaryResponseSchema = z.object({
  summary: MonitoringSummarySchema,
});
export type MonitoringSummaryResponse = z.infer<
  typeof MonitoringSummaryResponseSchema
>;

/** GET /v1/monitoring/replay?from=&to=&limit= — ordered ascending. */
export const MonitoringReplayResponseSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  events: z.array(MonitoringEventSchema),
});
export type MonitoringReplayResponse = z.infer<
  typeof MonitoringReplayResponseSchema
>;
