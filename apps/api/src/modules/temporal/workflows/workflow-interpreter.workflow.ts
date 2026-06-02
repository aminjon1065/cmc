import { proxyActivities, sleep } from "@temporalio/workflow";
import type { WorkflowInterpreterActivities } from "../activities/workflow-interpreter.types";

/**
 * Generic visual-workflow interpreter (P3.8b / ADR-0053). One Temporal workflow
 * executes ANY authored graph — the DAG is data, passed in as `args.definition`,
 * so adding/editing a workflow never needs a worker redeploy. Control nodes
 * (start/end/delay/condition) run in-workflow; side-effecting nodes (notify,
 * create_incident) call activities. Status is reported to the `workflow_runs`
 * row via `markRunStatus`.
 *
 * Determinism-safe: imports only `@temporalio/workflow` + a type-only activity
 * contract. The graph types are declared locally (no `@cmc/contracts` runtime in
 * the workflow sandbox); the runtime object is structurally the validated
 * `WorkflowDefinition`.
 */
const { markRunStatus, executeNotify, executeCreateIncident } =
  proxyActivities<WorkflowInterpreterActivities>({
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  });

type NodeType =
  | "start"
  | "end"
  | "notify"
  | "delay"
  | "condition"
  | "create_incident";

interface INode {
  id: string;
  type: NodeType;
  config?: Record<string, unknown>;
}
interface IEdge {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false";
}

export interface WorkflowInterpreterArgs {
  runId: string;
  tenantId: string;
  startedBy: string | null;
  definition: { nodes: INode[]; edges: IEdge[] };
  input: Record<string, unknown>;
}

export async function workflowInterpreter(
  args: WorkflowInterpreterArgs,
): Promise<string> {
  const { nodes, edges } = args.definition;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outBySource = new Map<string, IEdge[]>();
  for (const e of edges) {
    const list = outBySource.get(e.source) ?? [];
    list.push(e);
    outBySource.set(e.source, list);
  }

  const start = nodes.find((n) => n.type === "start");
  if (!start) {
    await markRunStatus(args.tenantId, args.runId, "failed", {
      error: "Definition has no start node.",
    });
    return "failed:no-start";
  }

  const context: Record<string, unknown> = { ...args.input };
  await markRunStatus(args.tenantId, args.runId, "running");

  try {
    let current: INode | undefined = start;
    let steps = 0;
    const maxSteps = nodes.length * 4 + 16; // DAG guard (graph is validated acyclic)

    while (current) {
      if (++steps > maxSteps) throw new Error("Step limit exceeded.");
      const node: INode = current;
      const outs = outBySource.get(node.id) ?? [];
      const follow = (branch?: "true" | "false"): INode | undefined => {
        const edge = branch ? outs.find((e) => e.branch === branch) : outs[0];
        return edge ? byId.get(edge.target) : undefined;
      };

      if (node.type === "end") {
        await markRunStatus(args.tenantId, args.runId, "completed", {
          output: context,
        });
        return "completed";
      } else if (node.type === "start") {
        current = follow();
      } else if (node.type === "delay") {
        const seconds = Number(
          (node.config as { seconds?: number } | undefined)?.seconds ?? 0,
        );
        if (seconds > 0) await sleep(seconds * 1000);
        current = follow();
      } else if (node.type === "condition") {
        const cfg = node.config as
          | { path?: string; equals?: string }
          | undefined;
        const actual = cfg?.path ? context[cfg.path] : undefined;
        const matched = String(actual ?? "") === String(cfg?.equals ?? "");
        current = follow(matched ? "true" : "false");
      } else if (node.type === "notify") {
        await executeNotify(
          args.tenantId,
          args.runId,
          node.config as { title: string; body: string; toUserId?: string },
          args.startedBy,
        );
        current = follow();
      } else if (node.type === "create_incident") {
        const id = await executeCreateIncident(
          args.tenantId,
          node.config as {
            severity: number;
            type: string;
            region: string;
            summary: string;
          },
          args.startedBy,
        );
        context.lastIncidentId = id;
        current = follow();
      } else {
        throw new Error(`Unknown node type: ${String(node.type)}`);
      }
    }

    // Reached a node with no outgoing edge that wasn't an end → still success.
    await markRunStatus(args.tenantId, args.runId, "completed", {
      output: context,
    });
    return "completed:dead-end";
  } catch (err) {
    await markRunStatus(args.tenantId, args.runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}
