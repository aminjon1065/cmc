import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ZodError, type ZodSchema } from "zod";
import { schema } from "@cmc/db";
import {
  CreateWorkflowSchema,
  RunWorkflowSchema,
  UpdateWorkflowSchema,
  ValidateWorkflowSchema,
  validateWorkflowDefinition,
  type ValidateWorkflowResponse,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowTriggerType,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { TEMPORAL_CLIENT, type TemporalClient } from "../temporal/temporal-client";

type WorkflowRow = typeof schema.workflows.$inferSelect;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const EMPTY_DEFINITION: WorkflowDefinition = { nodes: [], edges: [] };

/**
 * Zod-parse a request body; ZodError → 400 with the flattened messages folded
 * into the problem+json `detail` (the filter drops non-standard fields).
 * Structured per-error feedback for the editor comes from the `/validate`
 * endpoint's 200 body, not from this safety-net exception.
 */
function parse<T>(s: ZodSchema<T>, raw: unknown): T {
  try {
    return s.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new BadRequestException(`Invalid workflow payload — ${issues}`);
    }
    throw err;
  }
}

/**
 * Workflow definitions (P3.8 / ADR-0053). CRUD over the `workflows` table — the
 * graph is stored as data and executed by the interpreter (P3.8b). A draft may
 * be saved with an incomplete graph; enabling (or running, P3.8b) requires the
 * DAG to pass `validateWorkflowDefinition`. TenantDatabaseService + AuditService
 * are @Global; RLS confines everything to the caller's tenant.
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: TemporalClient,
  ) {}

  private toContract(row: WorkflowRow): Workflow {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      definition: row.definition as WorkflowDefinition,
      version: row.version,
      enabled: row.enabled,
      trigger: {
        type: row.triggerType as WorkflowTriggerType,
        ...(row.triggerEvent ? { event: row.triggerEvent } : {}),
      },
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Reject if the graph isn't a runnable DAG (used on enable + run). */
  private assertRunnable(def: WorkflowDefinition): void {
    const errors = validateWorkflowDefinition(def);
    if (errors.length > 0) {
      throw new BadRequestException(
        `Workflow definition is not runnable — ${errors.join("; ")}`,
      );
    }
  }

  async create(raw: unknown): Promise<Workflow> {
    const ctx = this.tenantContext.requireCurrent();
    const input = parse(CreateWorkflowSchema, raw);
    const definition = input.definition ?? EMPTY_DEFINITION;
    const enabled = input.enabled ?? false;
    const trigger = input.trigger ?? { type: "manual" as const };
    if (enabled) this.assertRunnable(definition);

    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.workflows)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          definition,
          enabled,
          triggerType: trigger.type,
          triggerEvent: trigger.event ?? null,
          createdBy: ctx.userId,
        })
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "workflow.created",
      resourceType: "workflow",
      resourceId: row!.id,
      outcome: "success",
      metadata: { name: input.name, enabled },
    });
    return this.toContract(row!);
  }

  async list(): Promise<Workflow[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.workflows)
        .where(isNull(schema.workflows.deletedAt))
        .orderBy(desc(schema.workflows.updatedAt)),
    );
    return rows.map((r) => this.toContract(r));
  }

  private async getRowOrFail(id: string): Promise<WorkflowRow> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.workflows)
        .where(
          and(eq(schema.workflows.id, id), isNull(schema.workflows.deletedAt)),
        )
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException("Workflow not found.");
    return rows[0];
  }

  async get(id: string): Promise<Workflow> {
    return this.toContract(await this.getRowOrFail(id));
  }

  async update(id: string, raw: unknown): Promise<Workflow> {
    const ctx = this.tenantContext.requireCurrent();
    const input = parse(UpdateWorkflowSchema, raw);
    const existing = await this.getRowOrFail(id);

    const definition =
      input.definition ?? (existing.definition as WorkflowDefinition);
    const enabled = input.enabled ?? existing.enabled;
    if (enabled) this.assertRunnable(definition);

    const [row] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.workflows)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          // A definition change bumps the version (run pinning / display).
          ...(input.definition !== undefined
            ? { definition, version: (existing.version ?? 1) + 1 }
            : {}),
          ...(input.enabled !== undefined ? { enabled } : {}),
          ...(input.trigger !== undefined
            ? {
                triggerType: input.trigger.type,
                triggerEvent: input.trigger.event ?? null,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.workflows.id, id))
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "workflow.updated",
      resourceType: "workflow",
      resourceId: id,
      outcome: "success",
      metadata: { enabled },
    });
    return this.toContract(row!);
  }

  async remove(id: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    await this.getRowOrFail(id);
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.workflows)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.workflows.id, id)),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "workflow.deleted",
      resourceType: "workflow",
      resourceId: id,
      outcome: "success",
    });
  }

  /** Validate a definition without persisting (powers the editor). */
  validate(raw: unknown): ValidateWorkflowResponse {
    const input = parse(ValidateWorkflowSchema, raw);
    const errors = validateWorkflowDefinition(input.definition);
    return { valid: errors.length === 0, errors };
  }

  // ---------- runs (P3.8b) ----------

  private toRunContract(row: WorkflowRunRow): WorkflowRun {
    return {
      id: row.id,
      workflowId: row.workflowId,
      workflowVersion: row.workflowVersion,
      status: row.status as WorkflowRunStatus,
      trigger: row.trigger as WorkflowRun["trigger"],
      input: (row.input ?? {}) as Record<string, unknown>,
      output: (row.output ?? null) as Record<string, unknown> | null,
      error: row.error,
      startedBy: row.startedBy,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    };
  }

  /**
   * Start a run: snapshot the (valid) graph into a `workflow_runs` row, then
   * start the interpreter Temporal execution (self-reports status via
   * activities). Internal so P3.8c's event trigger can reuse it with a system
   * actor + `event` trigger.
   */
  async startRun(
    workflowId: string,
    input: Record<string, unknown>,
    opts: { trigger: WorkflowRun["trigger"]; startedBy: string | null },
  ): Promise<WorkflowRun> {
    const ctx = this.tenantContext.requireCurrent();
    const wf = await this.getRowOrFail(workflowId);
    const definition = wf.definition as WorkflowDefinition;
    this.assertRunnable(definition); // a run needs a valid DAG

    const [run] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.workflowRuns)
        .values({
          tenantId: ctx.tenantId,
          workflowId: wf.id,
          workflowVersion: wf.version,
          definition,
          status: "pending",
          trigger: opts.trigger,
          input,
          startedBy: opts.startedBy,
        })
        .returning(),
    );
    const runId = run!.id;
    const temporalWorkflowId = `wf-run:${runId}`;

    try {
      await this.temporal.start({
        workflowType: "workflowInterpreter",
        workflowId: temporalWorkflowId,
        args: [
          {
            runId,
            tenantId: ctx.tenantId,
            startedBy: opts.startedBy,
            definition,
            input,
          },
        ],
      });
      await this.tenantDb.run((tx) =>
        tx
          .update(schema.workflowRuns)
          .set({ temporalWorkflowId })
          .where(eq(schema.workflowRuns.id, runId)),
      );
    } catch (err) {
      this.logger.warn(`workflow run ${runId} failed to start: ${msg(err)}`);
      await this.tenantDb.run((tx) =>
        tx
          .update(schema.workflowRuns)
          .set({
            status: "failed",
            error: "Failed to start execution.",
            finishedAt: sql`now()`,
          })
          .where(eq(schema.workflowRuns.id, runId)),
      );
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: opts.startedBy,
      actorType: opts.startedBy ? "user" : "system",
      action: "workflow.run",
      resourceType: "workflow",
      resourceId: wf.id,
      outcome: "success",
      metadata: { runId, trigger: opts.trigger },
    });
    return this.toRunContract(await this.getRunRowOrFail(runId));
  }

  /** Manual run from the API (current user is the initiator). */
  async run(workflowId: string, raw: unknown): Promise<WorkflowRun> {
    const ctx = this.tenantContext.requireCurrent();
    const input = parse(RunWorkflowSchema, raw);
    return this.startRun(workflowId, input.input ?? {}, {
      trigger: "manual",
      startedBy: ctx.userId,
    });
  }

  private async getRunRowOrFail(runId: string): Promise<WorkflowRunRow> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, runId))
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException("Workflow run not found.");
    return rows[0];
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    return this.toRunContract(await this.getRunRowOrFail(runId));
  }

  async listRuns(workflowId: string): Promise<WorkflowRun[]> {
    await this.getRowOrFail(workflowId); // 404 cross-tenant / unknown
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowId, workflowId))
        .orderBy(desc(schema.workflowRuns.startedAt))
        .limit(100),
    );
    return rows.map((r) => this.toRunContract(r));
  }

  // ---------- event triggers (P3.8c) ----------

  /**
   * Enabled, event-triggered workflows in a tenant bound to `eventToken`
   * (`${aggregateType}.${eventType}`, e.g. `incident.created`). Context-free
   * (runs in `runForTenant`) so the NATS consumer can call it without a request.
   */
  async findEnabledEventWorkflows(
    tenantId: string,
    eventToken: string,
  ): Promise<Array<{ id: string; version: number; definition: unknown }>> {
    return this.tenantDb.runForTenant(tenantId, async () => {
      const tx = this.tenantDb.getCurrentTx()!;
      return tx
        .select({
          id: schema.workflows.id,
          version: schema.workflows.version,
          definition: schema.workflows.definition,
        })
        .from(schema.workflows)
        .where(
          and(
            eq(schema.workflows.triggerType, "event"),
            eq(schema.workflows.triggerEvent, eventToken),
            eq(schema.workflows.enabled, true),
            isNull(schema.workflows.deletedAt),
          ),
        );
    });
  }

  /**
   * Start a run from an event trigger (system actor, no request context).
   * Snapshots + starts the interpreter; invalid graphs are skipped (logged).
   */
  async startTriggeredRun(
    tenantId: string,
    wf: { id: string; version: number; definition: unknown },
    payload: Record<string, unknown>,
  ): Promise<void> {
    const definition = wf.definition as WorkflowDefinition;
    if (validateWorkflowDefinition(definition).length > 0) {
      this.logger.warn(`event-trigger skipped invalid workflow ${wf.id}`);
      return;
    }
    const runId = await this.tenantDb.runForTenant(tenantId, async () => {
      const tx = this.tenantDb.getCurrentTx()!;
      const [r] = await tx
        .insert(schema.workflowRuns)
        .values({
          tenantId,
          workflowId: wf.id,
          workflowVersion: wf.version,
          definition,
          status: "pending",
          trigger: "event",
          input: payload,
          startedBy: null,
        })
        .returning({ id: schema.workflowRuns.id });
      return r!.id;
    });

    const temporalWorkflowId = `wf-run:${runId}`;
    try {
      await this.temporal.start({
        workflowType: "workflowInterpreter",
        workflowId: temporalWorkflowId,
        args: [{ runId, tenantId, startedBy: null, definition, input: payload }],
      });
      await this.tenantDb.runForTenant(tenantId, async () => {
        const tx = this.tenantDb.getCurrentTx()!;
        await tx
          .update(schema.workflowRuns)
          .set({ temporalWorkflowId })
          .where(eq(schema.workflowRuns.id, runId));
      });
    } catch (err) {
      this.logger.warn(`event-trigger run ${runId} failed to start: ${msg(err)}`);
      await this.tenantDb.runForTenant(tenantId, async () => {
        const tx = this.tenantDb.getCurrentTx()!;
        await tx
          .update(schema.workflowRuns)
          .set({
            status: "failed",
            error: "Failed to start execution.",
            finishedAt: sql`now()`,
          })
          .where(eq(schema.workflowRuns.id, runId));
      });
    }
  }
}
