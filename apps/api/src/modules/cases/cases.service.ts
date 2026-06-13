import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  canTransitionCase,
  CASE_OPEN_STATUSES,
  type AddCaseCommentRequest,
  type CaseActivitiesResponse,
  type CaseActivityKind,
  type CaseActivityResponse,
  type CaseDetail,
  type CaseStatsResponse,
  type CaseStatus,
  type CaseSummary,
  type CasesListResponse,
  type CreateCaseRequest,
  type UpdateCaseRequest,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { OutboxService } from "../events/outbox.service";
import {
  RegionScopeService,
  regionScopeCondition,
} from "../regions/region-scope.service";

type Actor = {
  userId: string;
  tenantId: string;
  ip?: string | null;
  userAgent?: string | null;
};
type CaseRow = typeof schema.cases.$inferSelect;
type ActivityRow = typeof schema.caseActivity.$inferSelect;
type UserRef = { id: string; name: string };
type Tx = Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0];

export type ListCasesFilters = {
  status?: CaseStatus;
  priority?: number;
  type?: string;
  assignedTo?: string;
  q?: string;
  open?: boolean;
  limit?: number;
  offset?: number;
};

/**
 * Case domain logic (P2.10 / ADR-0040), modelled on incidents (P1.5): all
 * reads/writes run in the request's tenant tx (RLS confines them; a cross-tenant
 * id is a clean miss → 404). State changes go through {@link transition},
 * validated against the shared state machine, and every create/transition/assign
 * writes a `case_activity` row + emits a domain event to the outbox.
 */
@Injectable()
export class CasesService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly regionScope: RegionScopeService,
  ) {}

  /** Open statuses still owe SLA work → eligible for an active timer. */
  private isOpen(status: string): boolean {
    return (CASE_OPEN_STATUSES as readonly string[]).includes(status);
  }

  // ---------- create ----------

  async create(input: CreateCaseRequest, actor: Actor): Promise<CaseDetail> {
    // Stamp the creator's region (P4.6b) so regional reads scope to it.
    const scope = await this.regionScope.current();
    const id = await this.tenantDb.run(async (tx) => {
      if (input.assignedTo) await this.assertTenantUser(tx, input.assignedTo);
      const [row] = await tx
        .insert(schema.cases)
        .values({
          tenantId: actor.tenantId,
          title: input.title,
          type: input.type,
          priority: input.priority ?? 3,
          status: "open",
          regionId: scope.regionId,
          description: input.description ?? null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assignedTo: input.assignedTo ?? null,
          openedBy: actor.userId,
        })
        .returning({ id: schema.cases.id });
      const caseId = row!.id;
      await this.insertActivity(tx, actor, caseId, "created", null, {
        type: input.type,
        priority: input.priority ?? 3,
      });
      return caseId;
    });

    await this.record(actor, "case.created", id, {
      type: input.type,
      priority: input.priority ?? 3,
    });
    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "case",
      aggregateId: id,
      eventType: "created",
      payload: {
        title: input.title,
        type: input.type,
        priority: input.priority ?? 3,
        status: "open",
        openedBy: actor.userId,
      },
    });
    return (await this.getDetail(id))!;
  }

  // ---------- read ----------

  async list(filters: ListCasesFilters): Promise<CasesListResponse> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const scope = await this.regionScope.current();

    return this.tenantDb.run(async (tx) => {
      const conds = [isNull(schema.cases.deletedAt)];
      const rc = regionScopeCondition(schema.cases.regionId, scope);
      if (rc) conds.push(rc);
      if (filters.status) conds.push(eq(schema.cases.status, filters.status));
      if (filters.priority)
        conds.push(eq(schema.cases.priority, filters.priority));
      if (filters.type) conds.push(eq(schema.cases.type, filters.type));
      if (filters.assignedTo)
        conds.push(eq(schema.cases.assignedTo, filters.assignedTo));
      if (filters.q) conds.push(ilike(schema.cases.title, `%${filters.q}%`));
      if (filters.open)
        conds.push(inArray(schema.cases.status, [...CASE_OPEN_STATUSES]));
      const where = and(...conds);

      const rows = await tx
        .select()
        .from(schema.cases)
        .where(where)
        .orderBy(desc(schema.cases.createdAt))
        .limit(limit)
        .offset(offset);
      const totalRows = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.cases)
        .where(where);

      const userMap = await this.userMapFor(tx, rows);
      return {
        cases: rows.map((r) => this.toSummary(r, userMap)),
        total: totalRows[0]?.value ?? 0,
        limit,
        offset,
      };
    });
  }

  async getDetail(id: string): Promise<CaseDetail | null> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      const row = (
        await tx
          .select()
          .from(schema.cases)
          .where(
            and(
              eq(schema.cases.id, id),
              isNull(schema.cases.deletedAt),
              regionScopeCondition(schema.cases.regionId, scope),
            ),
          )
          .limit(1)
      )[0];
      if (!row) return null;
      const userMap = await this.userMapFor(tx, [row]);
      return { ...this.toSummary(row, userMap), description: row.description };
    });
  }

  async listActivity(id: string): Promise<CaseActivitiesResponse> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      // Confirm the case is visible to this actor (tenant + region) — clean 404.
      const exists = await tx
        .select({ id: schema.cases.id })
        .from(schema.cases)
        .where(
          and(
            eq(schema.cases.id, id),
            isNull(schema.cases.deletedAt),
            regionScopeCondition(schema.cases.regionId, scope),
          ),
        )
        .limit(1);
      if (exists.length === 0) throw new NotFoundException("Case not found");

      const rows = await tx
        .select()
        .from(schema.caseActivity)
        .where(eq(schema.caseActivity.caseId, id))
        .orderBy(desc(schema.caseActivity.createdAt));
      const actorIds = rows
        .map((r) => r.actorId)
        .filter((v): v is string => !!v);
      const userMap = await this.usersByIds(tx, actorIds);
      return { activities: rows.map((r) => this.toActivity(r, userMap)) };
    });
  }

  async stats(): Promise<CaseStatsResponse> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      const statusRows = await tx
        .select({
          status: schema.cases.status,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.cases)
        .where(
          and(
            isNull(schema.cases.deletedAt),
            regionScopeCondition(schema.cases.regionId, scope),
          ),
        )
        .groupBy(schema.cases.status);

      const prioRows = await tx
        .select({
          priority: schema.cases.priority,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.cases)
        .where(
          and(
            isNull(schema.cases.deletedAt),
            inArray(schema.cases.status, [...CASE_OPEN_STATUSES]),
            regionScopeCondition(schema.cases.regionId, scope),
          ),
        )
        .groupBy(schema.cases.priority);

      const byStatus: Record<string, number> = {};
      let openTotal = 0;
      for (const r of statusRows) {
        byStatus[r.status] = r.value;
        if ((CASE_OPEN_STATUSES as readonly string[]).includes(r.status)) {
          openTotal += r.value;
        }
      }
      const byPriority: Record<string, number> = {};
      for (const r of prioRows) byPriority[String(r.priority)] = r.value;
      return { openTotal, byStatus, byPriority };
    });
  }

  // ---------- update / transition / assign ----------

  async update(
    id: string,
    changes: UpdateCaseRequest,
    actor: Actor,
  ): Promise<CaseDetail> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Case not found");
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.cases)
        .set({
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          ...(changes.type !== undefined ? { type: changes.type } : {}),
          ...(changes.priority !== undefined
            ? { priority: changes.priority }
            : {}),
          ...(changes.description !== undefined
            ? { description: changes.description }
            : {}),
          ...(changes.dueAt !== undefined
            ? { dueAt: changes.dueAt ? new Date(changes.dueAt) : null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.cases.id, id)),
    );
    await this.record(actor, "case.updated", id, {
      fields: Object.keys(changes),
    });
    return (await this.getDetail(id))!;
  }

  async transition(
    id: string,
    to: CaseStatus,
    opts: { note?: string },
    actor: Actor,
  ): Promise<CaseDetail> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Case not found");
    const from = existing.status;
    if (from === to) throw new BadRequestException(`Case is already ${to}`);
    if (!canTransitionCase(from, to)) {
      throw new BadRequestException(`Cannot transition from ${from} to ${to}`);
    }

    await this.tenantDb.run(async (tx) => {
      await tx
        .update(schema.cases)
        .set({
          status: to,
          ...(to === "resolved" ? { resolvedAt: sql`now()` } : {}),
          ...(to === "closed" ? { closedAt: sql`now()` } : {}),
          ...(to === "in_progress"
            ? { resolvedAt: null, closedAt: null }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.cases.id, id));
      await this.insertActivity(tx, actor, id, "status_changed", opts.note ?? null, {
        from,
        to,
      });
    });

    await this.record(actor, "case.transitioned", id, {
      from,
      to,
      note: opts.note ?? null,
    });
    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "case",
      aggregateId: id,
      eventType: "transitioned",
      payload: { from, to, by: actor.userId, note: opts.note ?? null },
    });
    return (await this.getDetail(id))!;
  }

  async assign(
    id: string,
    userId: string | null,
    actor: Actor,
  ): Promise<CaseDetail> {
    if (!(await this.getDetail(id)))
      throw new NotFoundException("Case not found");

    await this.tenantDb.run(async (tx) => {
      if (userId !== null) await this.assertTenantUser(tx, userId);
      await tx
        .update(schema.cases)
        .set({ assignedTo: userId, updatedAt: sql`now()` })
        .where(eq(schema.cases.id, id));
      await this.insertActivity(tx, actor, id, "assigned", null, {
        assignedTo: userId,
      });
    });

    await this.record(actor, "case.assigned", id, { assignedTo: userId });
    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "case",
      aggregateId: id,
      eventType: "assigned",
      payload: { assignedTo: userId, by: actor.userId },
    });
    return (await this.getDetail(id))!;
  }

  async addComment(
    id: string,
    input: AddCaseCommentRequest,
    actor: Actor,
  ): Promise<CaseActivityResponse> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      const exists = await tx
        .select({ id: schema.cases.id })
        .from(schema.cases)
        .where(
          and(
            eq(schema.cases.id, id),
            isNull(schema.cases.deletedAt),
            regionScopeCondition(schema.cases.regionId, scope),
          ),
        )
        .limit(1);
      if (exists.length === 0) throw new NotFoundException("Case not found");

      const row = await this.insertActivity(
        tx,
        actor,
        id,
        "comment",
        input.body,
        {},
      );
      await tx
        .update(schema.cases)
        .set({ updatedAt: sql`now()` })
        .where(eq(schema.cases.id, id));
      const userMap = await this.usersByIds(tx, [actor.userId]);
      return this.toActivity(row, userMap);
    });
  }

  async softDelete(id: string, actor: Actor): Promise<void> {
    if (!(await this.getDetail(id)))
      throw new NotFoundException("Case not found");
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.cases)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.cases.id, id)),
    );
    await this.record(actor, "case.deleted", id);
  }

  // ---------- helpers ----------

  private async assertTenantUser(tx: Tx, userId: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1);
    if (rows.length === 0) {
      throw new BadRequestException("Assignee is not a user in this tenant");
    }
  }

  private async insertActivity(
    tx: Tx,
    actor: Actor,
    caseId: string,
    kind: CaseActivityKind,
    body: string | null,
    metadata: Record<string, unknown>,
  ): Promise<ActivityRow> {
    const [row] = await tx
      .insert(schema.caseActivity)
      .values({
        tenantId: actor.tenantId,
        caseId,
        actorId: actor.userId,
        kind,
        body,
        metadata,
      })
      .returning();
    return row!;
  }

  private async userMapFor(
    tx: Tx,
    rows: CaseRow[],
  ): Promise<Map<string, UserRef>> {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.assignedTo) ids.add(r.assignedTo);
      if (r.openedBy) ids.add(r.openedBy);
    }
    return this.usersByIds(tx, [...ids]);
  }

  private async usersByIds(
    tx: Tx,
    ids: string[],
  ): Promise<Map<string, UserRef>> {
    const map = new Map<string, UserRef>();
    if (ids.length === 0) return map;
    const rows = await tx
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(inArray(schema.users.id, ids));
    for (const u of rows) map.set(u.id, { id: u.id, name: u.name });
    return map;
  }

  private toSummary(row: CaseRow, userMap: Map<string, UserRef>): CaseSummary {
    const ref = (id: string | null) => (id ? (userMap.get(id) ?? null) : null);
    return {
      id: row.id,
      title: row.title,
      type: row.type,
      priority: row.priority,
      status: row.status as CaseStatus,
      regionId: row.regionId ?? null,
      assignedTo: ref(row.assignedTo),
      openedBy: ref(row.openedBy),
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toActivity(
    row: ActivityRow,
    userMap: Map<string, UserRef>,
  ): CaseActivityResponse {
    return {
      id: row.id,
      kind: row.kind as CaseActivityKind,
      body: row.body,
      actor: row.actorId ? (userMap.get(row.actorId) ?? null) : null,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async record(
    actor: Actor,
    action: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action,
      resourceType: "case",
      resourceId,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      ...(metadata ? { metadata } : {}),
    });
  }
}
