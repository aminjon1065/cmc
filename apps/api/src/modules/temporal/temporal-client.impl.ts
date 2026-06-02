import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import type { StartWorkflowInput, TemporalClient } from "./temporal-client";

type Opts = { address: string; namespace: string; taskQueue: string };

/**
 * Real Temporal client (P3.1 / ADR-0045). Only loaded via dynamic import from
 * the factory when `TEMPORAL_ENABLED`, so `@temporalio/client` never enters jest.
 */
export class RealTemporalClient implements TemporalClient {
  readonly active = true;

  private constructor(
    private readonly connection: Connection,
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  static async create(opts: Opts): Promise<RealTemporalClient> {
    const connection = await Connection.connect({ address: opts.address });
    const client = new Client({ connection, namespace: opts.namespace });
    return new RealTemporalClient(connection, client, opts.taskQueue);
  }

  async start(input: StartWorkflowInput): Promise<void> {
    // TERMINATE_EXISTING makes start idempotent-by-replace: a fresh schedule for
    // a case whose timer is already running atomically terminates the old one and
    // starts a new one — exactly the "reschedule on due_at change" semantics.
    await this.client.workflow.start(input.workflowType, {
      taskQueue: this.taskQueue,
      workflowId: input.workflowId,
      args: input.args,
      workflowIdConflictPolicy: "TERMINATE_EXISTING",
    });
  }

  async cancel(workflowId: string): Promise<void> {
    try {
      await this.client.workflow.getHandle(workflowId).cancel();
    } catch (err) {
      // Unknown / already-closed id → nothing to cancel.
      if (err instanceof WorkflowNotFoundError) return;
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
