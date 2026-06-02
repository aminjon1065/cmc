import { z } from "zod";

/**
 * Incident contracts (P1.5 / ADR-0023).
 *
 * The status state machine (`INCIDENT_TRANSITIONS`) is the single source of
 * truth shared by the API (validates a transition) and the web (shows only the
 * reachable next states). `region`/`type`/`source` are free text — no
 * jurisdiction enum is baked in here (the web supplies suggestions), same
 * principle as branding (P0.11).
 */

// ---------- status state machine ----------

export const INCIDENT_STATUSES = [
  "reported",
  "triaged",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);

/** Allowed transitions (from → to[]). Terminal states map to []. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  reported: ["triaged", "cancelled"],
  triaged: ["in_progress", "cancelled"],
  in_progress: ["resolved", "cancelled"],
  resolved: ["closed", "in_progress"], // reopen → in_progress
  closed: ["in_progress"], // reopen → in_progress
  cancelled: [],
};

/** Target statuses that require the `incident:resolve` permission. */
export const RESOLVING_STATUSES: readonly IncidentStatus[] = [
  "resolved",
  "closed",
];

/** Non-terminal statuses — an incident here still needs work (response active). */
export const INCIDENT_OPEN_STATUSES: readonly IncidentStatus[] = [
  "reported",
  "triaged",
  "in_progress",
];

export function canTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): boolean {
  return INCIDENT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------- shared field schemas ----------

/** 1..5, 1 = most severe (SEV-1). */
export const IncidentSeveritySchema = z.number().int().min(1).max(5);

const UserRefSchema = z
  .object({ id: z.string().uuid(), name: z.string() })
  .nullable();

// ---------- responses ----------

export const IncidentSummarySchema = z.object({
  id: z.string().uuid(),
  severity: z.number().int(),
  status: IncidentStatusSchema,
  type: z.string(),
  region: z.string(),
  source: z.string().nullable(),
  summary: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  occurredAt: z.string().datetime(),
  reportedBy: UserRefSchema,
  assignedTo: UserRefSchema,
  resolvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const IncidentDetailSchema = IncidentSummarySchema.extend({
  description: z.string().nullable(),
});
export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;

export const IncidentDetailResponseSchema = z.object({
  incident: IncidentDetailSchema,
});
export type IncidentDetailResponse = z.infer<
  typeof IncidentDetailResponseSchema
>;

export const IncidentsListResponseSchema = z.object({
  incidents: z.array(IncidentSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type IncidentsListResponse = z.infer<
  typeof IncidentsListResponseSchema
>;

/** Aggregate counts for the dashboard (P1.5c). */
export const IncidentStatsResponseSchema = z.object({
  activeTotal: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  byRegion: z.array(
    z.object({ region: z.string(), count: z.number().int().nonnegative() }),
  ),
  byType: z.array(
    z.object({ type: z.string(), count: z.number().int().nonnegative() }),
  ),
});
export type IncidentStatsResponse = z.infer<
  typeof IncidentStatsResponseSchema
>;

// ---------- requests ----------

export const CreateIncidentRequestSchema = z.object({
  severity: IncidentSeveritySchema,
  type: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(120),
  source: z.string().trim().max(120).optional(),
  summary: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  occurredAt: z.string().datetime(),
});
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

export const UpdateIncidentRequestSchema = z
  .object({
    severity: IncidentSeveritySchema.optional(),
    type: z.string().trim().min(1).max(80).optional(),
    region: z.string().trim().min(1).max(120).optional(),
    source: z.string().trim().max(120).nullable().optional(),
    summary: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });
export type UpdateIncidentRequest = z.infer<typeof UpdateIncidentRequestSchema>;

export const TransitionIncidentRequestSchema = z.object({
  to: IncidentStatusSchema,
  note: z.string().trim().max(1000).optional(),
});
export type TransitionIncidentRequest = z.infer<
  typeof TransitionIncidentRequestSchema
>;

export const AssignIncidentRequestSchema = z.object({
  /** Target user id, or null to unassign. */
  userId: z.string().uuid().nullable(),
});
export type AssignIncidentRequest = z.infer<
  typeof AssignIncidentRequestSchema
>;

/** Active tenant members an incident can be assigned to (gated incident:assign). */
export const IncidentAssigneesResponseSchema = z.object({
  assignees: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export type IncidentAssigneesResponse = z.infer<
  typeof IncidentAssigneesResponseSchema
>;
