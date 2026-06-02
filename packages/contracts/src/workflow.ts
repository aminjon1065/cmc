import { z } from "zod";

/**
 * Visual workflow builder contracts (P3.8 / ADR-0053). A workflow is a DAG of
 * typed nodes + edges, stored as data and executed by a generic interpreter
 * Temporal workflow (P3.8b). The node config schemas here are the single source
 * of truth for the web builder, the API validation, and the interpreter.
 */

export const WORKFLOW_NODE_TYPES = [
  "start",
  "end",
  "notify",
  "delay",
  "condition",
  "create_incident",
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

const nodeId = z.string().min(1).max(64);
const PositionSchema = z.object({ x: z.number(), y: z.number() });
const labelField = z.string().max(120).optional();

// ---------- per-type node configs ----------

export const NotifyConfigSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  /** Recipient; defaults to the run's initiator when omitted. */
  toUserId: z.string().uuid().optional(),
});
export const DelayConfigSchema = z.object({
  seconds: z.number().int().min(1).max(86_400),
});
export const ConditionConfigSchema = z.object({
  /** Dot-free key looked up in the run input/context (P3.8b). */
  path: z.string().min(1).max(120),
  /** Equality compared as a string. */
  equals: z.string().max(500),
});
export const CreateIncidentConfigSchema = z.object({
  severity: z.number().int().min(1).max(5),
  type: z.string().min(1).max(80),
  region: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
});

const baseNode = { id: nodeId, label: labelField, position: PositionSchema };

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  z.object({ ...baseNode, type: z.literal("start") }),
  z.object({ ...baseNode, type: z.literal("end") }),
  z.object({ ...baseNode, type: z.literal("notify"), config: NotifyConfigSchema }),
  z.object({ ...baseNode, type: z.literal("delay"), config: DelayConfigSchema }),
  z.object({
    ...baseNode,
    type: z.literal("condition"),
    config: ConditionConfigSchema,
  }),
  z.object({
    ...baseNode,
    type: z.literal("create_incident"),
    config: CreateIncidentConfigSchema,
  }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WORKFLOW_EDGE_BRANCHES = ["true", "false"] as const;
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: nodeId,
  target: nodeId,
  /** Only meaningful on edges leaving a condition node. */
  branch: z.enum(WORKFLOW_EDGE_BRANCHES).optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).max(200),
  edges: z.array(WorkflowEdgeSchema).max(400),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WORKFLOW_TRIGGER_TYPES = ["manual", "event"] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];
export const WorkflowTriggerSchema = z
  .object({
    type: z.enum(WORKFLOW_TRIGGER_TYPES),
    /** Event subject to auto-start on (P3.8c); required when type='event'. */
    event: z.string().min(1).max(120).optional(),
  })
  .refine((t) => t.type !== "event" || !!t.event, {
    message: "An event-triggered workflow needs an event subject.",
    path: ["event"],
  });
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

/**
 * Structural DAG validation beyond the Zod shape. Returns a list of human
 * errors (empty = runnable). Enforced when enabling/running a workflow; drafts
 * may be saved incomplete.
 */
export function validateWorkflowDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const { nodes, edges } = def;

  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}".`);
    ids.add(n.id);
  }

  const starts = nodes.filter((n) => n.type === "start");
  const ends = nodes.filter((n) => n.type === "end");
  if (starts.length !== 1)
    errors.push(`Exactly one start node is required (found ${starts.length}).`);
  if (ends.length < 1) errors.push("At least one end node is required.");

  for (const e of edges) {
    if (!ids.has(e.source)) errors.push(`Edge "${e.id}" has an unknown source.`);
    if (!ids.has(e.target)) errors.push(`Edge "${e.id}" has an unknown target.`);
  }

  const out = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  const incoming = new Map<string, number>();
  for (const e of edges) {
    out.get(e.source)?.push(e);
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }

  for (const n of nodes) {
    const outs = out.get(n.id) ?? [];
    if (n.type === "start") {
      if ((incoming.get(n.id) ?? 0) > 0)
        errors.push("The start node must have no incoming edges.");
      if (outs.length !== 1)
        errors.push("The start node must have exactly one outgoing edge.");
    } else if (n.type === "end") {
      if (outs.length > 0)
        errors.push(`End node "${n.id}" must have no outgoing edges.`);
    } else if (n.type === "condition") {
      const branches = new Set(outs.map((e) => e.branch));
      if (outs.length !== 2 || !branches.has("true") || !branches.has("false"))
        errors.push(
          `Condition node "${n.id}" needs exactly two outgoing edges, branched "true" and "false".`,
        );
    } else {
      if (outs.length !== 1)
        errors.push(`Node "${n.id}" must have exactly one outgoing edge.`);
    }
    if (n.type !== "condition") {
      for (const e of outs)
        if (e.branch)
          errors.push(`Edge "${e.id}" sets a branch but its source isn't a condition.`);
    }
  }

  // Reachability + acyclicity only once the structure is otherwise sound.
  if (starts.length === 1 && errors.length === 0) {
    const startId = starts[0]!.id;
    const seen = new Set<string>();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of out.get(cur) ?? []) stack.push(e.target);
    }
    for (const n of nodes)
      if (!seen.has(n.id)) errors.push(`Node "${n.id}" is unreachable from start.`);

    const color = new Map<string, number>(nodes.map((n) => [n.id, 0]));
    let cyclic = false;
    const visit = (id: string): void => {
      color.set(id, 1);
      for (const e of out.get(id) ?? []) {
        const c = color.get(e.target);
        if (c === 1) {
          cyclic = true;
          return;
        }
        if (c === 0) visit(e.target);
      }
      color.set(id, 2);
    };
    visit(startId);
    if (cyclic) errors.push("The workflow graph must be acyclic.");
  }

  return errors;
}

// ---------- API shapes ----------

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  definition: WorkflowDefinitionSchema,
  version: z.number().int(),
  enabled: z.boolean(),
  trigger: WorkflowTriggerSchema,
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: WorkflowDefinitionSchema.optional(),
  enabled: z.boolean().optional(),
  trigger: WorkflowTriggerSchema.optional(),
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowSchema>;

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  definition: WorkflowDefinitionSchema.optional(),
  enabled: z.boolean().optional(),
  trigger: WorkflowTriggerSchema.optional(),
});
export type UpdateWorkflowRequest = z.infer<typeof UpdateWorkflowSchema>;

export const WorkflowResponseSchema = z.object({ workflow: WorkflowSchema });
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export const WorkflowsListResponseSchema = z.object({
  workflows: z.array(WorkflowSchema),
});
export type WorkflowsListResponse = z.infer<typeof WorkflowsListResponseSchema>;

export const ValidateWorkflowSchema = z.object({
  definition: WorkflowDefinitionSchema,
});
export type ValidateWorkflowRequest = z.infer<typeof ValidateWorkflowSchema>;

export const ValidateWorkflowResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type ValidateWorkflowResponse = z.infer<
  typeof ValidateWorkflowResponseSchema
>;

// ---------- runs (P3.8b) ----------

export const WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  workflowVersion: z.number().int(),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  trigger: z.enum(WORKFLOW_TRIGGER_TYPES),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  startedBy: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const RunWorkflowSchema = z.object({
  /** Optional input made available to condition nodes + activities. */
  input: z.record(z.unknown()).optional(),
});
export type RunWorkflowRequest = z.infer<typeof RunWorkflowSchema>;

export const WorkflowRunResponseSchema = z.object({ run: WorkflowRunSchema });
export type WorkflowRunResponse = z.infer<typeof WorkflowRunResponseSchema>;

export const WorkflowRunsListResponseSchema = z.object({
  runs: z.array(WorkflowRunSchema),
});
export type WorkflowRunsListResponse = z.infer<
  typeof WorkflowRunsListResponseSchema
>;
