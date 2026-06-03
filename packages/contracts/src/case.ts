import { z } from "zod";

/**
 * Case contracts (P2.10 / ADR-0040). The status state machine
 * (`CASE_TRANSITIONS`) is the single source of truth shared by the API
 * (validates a transition) and the web (shows reachable next states). `type` is
 * free text (config-driven case types are a follow-on).
 */

// ---------- status state machine ----------

export const CASE_STATUSES = [
  "open",
  "triage",
  "in_progress",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const CaseStatusSchema = z.enum(CASE_STATUSES);

/** Allowed transitions (from → to[]). Terminal states map to []. */
export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["triage", "in_progress", "cancelled"],
  triage: ["in_progress", "cancelled"],
  in_progress: ["resolved", "cancelled"],
  resolved: ["closed", "in_progress"], // reopen → in_progress
  closed: ["in_progress"], // reopen → in_progress
  cancelled: [],
};

/** Target statuses that require the `case:resolve` permission. */
export const CASE_RESOLVING_STATUSES: readonly CaseStatus[] = [
  "resolved",
  "closed",
];

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Non-terminal statuses — the "open" set used by stats/dashboard. */
export const CASE_OPEN_STATUSES: readonly CaseStatus[] = [
  "open",
  "triage",
  "in_progress",
];

// ---------- shared field schemas ----------

/** 1..5, 1 = highest priority. */
export const CasePrioritySchema = z.number().int().min(1).max(5);

export const CASE_ACTIVITY_KINDS = [
  "created",
  "status_changed",
  "assigned",
  "comment",
  "note",
  // Emitted by the Temporal SLA-escalation workflow (P3.1 / ADR-0045).
  "sla_breached",
] as const;
export type CaseActivityKind = (typeof CASE_ACTIVITY_KINDS)[number];

const UserRefSchema = z
  .object({ id: z.string().uuid(), name: z.string() })
  .nullable();

// ---------- responses ----------

export const CaseSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  type: z.string(),
  priority: z.number().int(),
  status: CaseStatusSchema,
  /** Structured region for access scoping (P4.6); null = unassigned/HQ pool. */
  regionId: z.string().uuid().nullable(),
  assignedTo: UserRefSchema,
  openedBy: UserRefSchema,
  dueAt: z.string().datetime().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseDetailSchema = CaseSummarySchema.extend({
  description: z.string().nullable(),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const CaseDetailResponseSchema = z.object({ case: CaseDetailSchema });
export type CaseDetailResponse = z.infer<typeof CaseDetailResponseSchema>;

export const CasesListResponseSchema = z.object({
  cases: z.array(CaseSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type CasesListResponse = z.infer<typeof CasesListResponseSchema>;

export const CaseActivityResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(CASE_ACTIVITY_KINDS),
  body: z.string().nullable(),
  actor: UserRefSchema,
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type CaseActivityResponse = z.infer<typeof CaseActivityResponseSchema>;

export const CaseActivitiesResponseSchema = z.object({
  activities: z.array(CaseActivityResponseSchema),
});
export type CaseActivitiesResponse = z.infer<
  typeof CaseActivitiesResponseSchema
>;

export const CaseStatsResponseSchema = z.object({
  openTotal: z.number().int().nonnegative(),
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
  byPriority: z.record(z.string(), z.number().int().nonnegative()),
});
export type CaseStatsResponse = z.infer<typeof CaseStatsResponseSchema>;

// ---------- requests ----------

export const CreateCaseRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.string().trim().min(1).max(80),
  priority: CasePrioritySchema.optional(),
  description: z.string().trim().max(10000).optional(),
  dueAt: z.string().datetime().optional(),
  assignedTo: z.string().uuid().optional(),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

export const UpdateCaseRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    type: z.string().trim().min(1).max(80),
    priority: CasePrioritySchema,
    description: z.string().trim().max(10000).nullable(),
    dueAt: z.string().datetime().nullable(),
  })
  .partial();
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestSchema>;

export const TransitionCaseRequestSchema = z.object({
  to: CaseStatusSchema,
  note: z.string().trim().max(2000).optional(),
});
export type TransitionCaseRequest = z.infer<typeof TransitionCaseRequestSchema>;

export const AssignCaseRequestSchema = z.object({
  userId: z.string().uuid().nullable(),
});
export type AssignCaseRequest = z.infer<typeof AssignCaseRequestSchema>;

export const AddCaseCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type AddCaseCommentRequest = z.infer<
  typeof AddCaseCommentRequestSchema
>;
