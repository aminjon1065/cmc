import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  canTransition,
  INCIDENT_OPEN_STATUSES,
  type CreateIncidentRequest,
  type IncidentDetail,
  type IncidentStatsResponse,
  type IncidentStatus,
  type IncidentSummary,
  type IncidentsListResponse,
  type UpdateIncidentRequest,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { OutboxService } from "../events/outbox.service";
import {
  RegionScopeService,
  regionScopeCondition,
} from "../regions/region-scope.service";
import type { AppConfig } from "../../config/configuration";

type Actor = {
  userId: string;
  tenantId: string;
  ip?: string | null;
  userAgent?: string | null;
};

type IncidentRow = typeof schema.incidents.$inferSelect;
type UserRef = { id: string; name: string };

export type ListIncidentsFilters = {
  status?: IncidentStatus;
  severity?: number;
  region?: string;
  regionId?: string;
  type?: string;
  assignedTo?: string;
  q?: string;
  active?: boolean;
  limit?: number;
  offset?: number;
};

/** Non-terminal statuses — the "active" set used by the dashboard. */
const ACTIVE_STATUSES: IncidentStatus[] = [
  "reported",
  "triaged",
  "in_progress",
];

/**
 * Incident domain logic (P1.5 / ADR-0023). All reads/writes run inside the
 * request's tenant transaction; RLS confines them to the caller's tenant, so a
 * cross-tenant id is a clean miss (→ 404 upstream). Status changes go through
 * {@link transition}, validated against the shared state machine.
 */
@Injectable()
export class IncidentsService {
  /**
   * When the event plane is on, incident notifications are dispatched by the
   * event consumer (P2.4) — so the inline dispatch below is skipped to avoid a
   * double-fire. When NATS is off (dev/test default), the inline dispatch is the
   * only path, preserving behaviour with zero regression.
   */
  private readonly natsEnabled: boolean;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly regionScope: RegionScopeService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.natsEnabled = config.get("NATS_ENABLED", { infer: true });
  }

  /** Open statuses keep the incident-response workflow active (P3.2). */
  private isOpen(status: string): boolean {
    return (INCIDENT_OPEN_STATUSES as readonly string[]).includes(status);
  }

  // ---------- create ----------

  async create(
    input: CreateIncidentRequest,
    actor: Actor,
  ): Promise<IncidentDetail> {
    // Stamp the creator's region (P4.6b) so regional reads scope to it.
    const scope = await this.regionScope.current();
    const id = await this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .insert(schema.incidents)
        .values({
          tenantId: actor.tenantId,
          severity: input.severity,
          status: "reported",
          type: input.type,
          region: input.region,
          regionId: scope.regionId,
          source: input.source ?? null,
          summary: input.summary,
          description: input.description ?? null,
          latitude: numOrNull(input.latitude),
          longitude: numOrNull(input.longitude),
          occurredAt: new Date(input.occurredAt),
          reportedBy: actor.userId,
        })
        .returning({ id: schema.incidents.id });
      return row!.id;
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "incident.created",
      resourceType: "incident",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { severity: input.severity, type: input.type, region: input.region },
    });

    // Emit the domain event in the SAME request transaction as the insert —
    // atomic with the state-change (P2.1 / ADR-0031). The relay ships it to NATS.
    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "incident",
      aggregateId: id,
      eventType: "created",
      payload: {
        severity: input.severity,
        status: "reported",
        type: input.type,
        region: input.region,
        summary: input.summary,
        reportedBy: actor.userId,
        occurredAt: input.occurredAt,
      },
    });

    return (await this.getDetail(id))!;
  }

  // ---------- read ----------

  async list(filters: ListIncidentsFilters): Promise<IncidentsListResponse> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const scope = await this.regionScope.current();

    return this.tenantDb.run(async (tx) => {
      const conds = [isNull(schema.incidents.deletedAt)];
      const rc = regionScopeCondition(schema.incidents.regionId, scope);
      if (rc) conds.push(rc);
      if (filters.status)
        conds.push(eq(schema.incidents.status, filters.status));
      if (filters.severity)
        conds.push(eq(schema.incidents.severity, filters.severity));
      if (filters.region)
        conds.push(eq(schema.incidents.region, filters.region));
      if (filters.regionId)
        conds.push(eq(schema.incidents.regionId, filters.regionId));
      if (filters.type) conds.push(eq(schema.incidents.type, filters.type));
      if (filters.assignedTo)
        conds.push(eq(schema.incidents.assignedTo, filters.assignedTo));
      if (filters.q)
        conds.push(ilike(schema.incidents.summary, `%${filters.q}%`));
      if (filters.active)
        conds.push(inArray(schema.incidents.status, ACTIVE_STATUSES));
      const where = and(...conds);

      const rows = await tx
        .select()
        .from(schema.incidents)
        .where(where)
        .orderBy(desc(schema.incidents.occurredAt))
        .limit(limit)
        .offset(offset);

      const totalRows = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.incidents)
        .where(where);
      const total = totalRows[0]?.value ?? 0;

      const incidents = await this.attachUsers(tx, rows);
      return { incidents, total, limit, offset };
    });
  }

  /**
   * Load a detail from OUTSIDE a request (e.g. the event consumer, P2.4) — opens
   * a tenant-scoped tx so `getDetail`'s `.run()` resolves + RLS confines it.
   */
  async getDetailForTenant(
    tenantId: string,
    id: string,
  ): Promise<IncidentDetail | null> {
    return this.tenantDb.runForTenant(tenantId, () => this.getDetail(id));
  }

  async getDetail(id: string): Promise<IncidentDetail | null> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      const row = (
        await tx
          .select()
          .from(schema.incidents)
          .where(
            and(
              eq(schema.incidents.id, id),
              isNull(schema.incidents.deletedAt),
              regionScopeCondition(schema.incidents.regionId, scope),
            ),
          )
          .limit(1)
      )[0];
      if (!row) return null;
      const userMap = await this.userMapFor(tx, [row]);
      return this.toDetail(row, userMap);
    });
  }

  /** Active tenant members an incident can be assigned to (for the assign UI). */
  async listAssignees(): Promise<UserRef[]> {
    return this.tenantDb.run((tx) =>
      tx
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.isActive, true),
            isNull(schema.users.deletedAt),
          ),
        )
        .orderBy(schema.users.name),
    );
  }

  /** Active-incident aggregates for the dashboard (P1.5c). */
  async stats(): Promise<IncidentStatsResponse> {
    const scope = await this.regionScope.current();
    return this.tenantDb.run(async (tx) => {
      const base = and(
        isNull(schema.incidents.deletedAt),
        inArray(schema.incidents.status, ACTIVE_STATUSES),
        regionScopeCondition(schema.incidents.regionId, scope),
      );

      const sev = await tx
        .select({
          severity: schema.incidents.severity,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.incidents)
        .where(base)
        .groupBy(schema.incidents.severity);

      const region = await tx
        .select({
          region: schema.incidents.region,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.incidents)
        .where(base)
        .groupBy(schema.incidents.region)
        .orderBy(desc(sql`count(*)`));

      const type = await tx
        .select({
          type: schema.incidents.type,
          value: sql<number>`count(*)::int`,
        })
        .from(schema.incidents)
        .where(base)
        .groupBy(schema.incidents.type)
        .orderBy(desc(sql`count(*)`));

      const bySeverity: Record<string, number> = {};
      let activeTotal = 0;
      for (const r of sev) {
        bySeverity[String(r.severity)] = r.value;
        activeTotal += r.value;
      }
      return {
        activeTotal,
        bySeverity,
        byRegion: region.map((r) => ({ region: r.region, count: r.value })),
        byType: type.map((r) => ({ type: r.type, count: r.value })),
      };
    });
  }

  // ---------- update ----------

  async update(
    id: string,
    changes: UpdateIncidentRequest,
    actor: Actor,
  ): Promise<IncidentDetail> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Incident not found");

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.incidents)
        .set({
          ...(changes.severity !== undefined
            ? { severity: changes.severity }
            : {}),
          ...(changes.type !== undefined ? { type: changes.type } : {}),
          ...(changes.region !== undefined ? { region: changes.region } : {}),
          ...(changes.source !== undefined ? { source: changes.source } : {}),
          ...(changes.summary !== undefined
            ? { summary: changes.summary }
            : {}),
          ...(changes.description !== undefined
            ? { description: changes.description }
            : {}),
          ...(changes.latitude !== undefined
            ? { latitude: numOrNull(changes.latitude) }
            : {}),
          ...(changes.longitude !== undefined
            ? { longitude: numOrNull(changes.longitude) }
            : {}),
          ...(changes.occurredAt !== undefined
            ? { occurredAt: new Date(changes.occurredAt) }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.incidents.id, id)),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "incident.updated",
      resourceType: "incident",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { fields: Object.keys(changes) },
    });

    return (await this.getDetail(id))!;
  }

  // ---------- transition (state machine) ----------

  async transition(
    id: string,
    to: IncidentStatus,
    opts: { note?: string },
    actor: Actor,
  ): Promise<IncidentDetail> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Incident not found");

    const from = existing.status;
    if (from === to) {
      throw new BadRequestException(`Incident is already ${to}`);
    }
    if (!canTransition(from, to)) {
      throw new BadRequestException(
        `Cannot transition from ${from} to ${to}`,
      );
    }

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.incidents)
        .set({
          status: to,
          // Stamp resolved_at on resolve; clear it on reopen.
          ...(to === "resolved" ? { resolvedAt: sql`now()` } : {}),
          ...(to === "in_progress" ? { resolvedAt: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.incidents.id, id)),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "incident.transitioned",
      resourceType: "incident",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { from, to, note: opts.note ?? null },
    });

    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "incident",
      aggregateId: id,
      eventType: "transitioned",
      payload: { from, to, by: actor.userId, note: opts.note ?? null },
    });

    const detail = (await this.getDetail(id))!;
    // Inline dispatch only when the event plane is off (else the event consumer
    // notifies — P2.4). Best-effort either way (never throws).
    if (!this.natsEnabled) {
      await this.notifications.incidentTransitioned(detail, from, to, actor);
    }
    return detail;
  }

  // ---------- assign ----------

  async assign(
    id: string,
    userId: string | null,
    actor: Actor,
  ): Promise<IncidentDetail> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Incident not found");

    if (userId !== null) {
      // RLS confines this to the tenant; a cross-tenant id simply isn't found.
      const assignee = await this.tenantDb.run((tx) =>
        tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)),
          )
          .limit(1),
      );
      if (assignee.length === 0) {
        throw new BadRequestException("Assignee is not a user in this tenant");
      }
    }

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.incidents)
        .set({ assignedTo: userId, updatedAt: sql`now()` })
        .where(eq(schema.incidents.id, id)),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "incident.assigned",
      resourceType: "incident",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { assignedTo: userId },
    });

    await this.outbox.publish({
      tenantId: actor.tenantId,
      aggregateType: "incident",
      aggregateId: id,
      eventType: "assigned",
      payload: { assignedTo: userId, by: actor.userId },
    });

    const detail = (await this.getDetail(id))!;
    // Inline dispatch only when the event plane is off (else the event consumer
    // notifies — P2.4). Best-effort either way (never throws).
    if (!this.natsEnabled) {
      await this.notifications.incidentAssigned(detail, actor);
    }
    return detail;
  }

  // ---------- delete ----------

  async softDelete(id: string, actor: Actor): Promise<void> {
    const existing = await this.getDetail(id);
    if (!existing) throw new NotFoundException("Incident not found");

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.incidents)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.incidents.id, id)),
    );

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "incident.deleted",
      resourceType: "incident",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  // ---------- helpers ----------

  private async userMapFor(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    rows: IncidentRow[],
  ): Promise<Map<string, UserRef>> {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.reportedBy) ids.add(r.reportedBy);
      if (r.assignedTo) ids.add(r.assignedTo);
    }
    const map = new Map<string, UserRef>();
    if (ids.size === 0) return map;
    const us = await tx
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(inArray(schema.users.id, [...ids]));
    for (const u of us) map.set(u.id, { id: u.id, name: u.name });
    return map;
  }

  private async attachUsers(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    rows: IncidentRow[],
  ): Promise<IncidentSummary[]> {
    const userMap = await this.userMapFor(tx, rows);
    return rows.map((r) => this.toSummary(r, userMap));
  }

  private toSummary(
    row: IncidentRow,
    userMap: Map<string, UserRef>,
  ): IncidentSummary {
    const ref = (id: string | null) => {
      if (!id) return null;
      const u = userMap.get(id);
      return u ? { id: u.id, name: u.name } : null;
    };
    return {
      id: row.id,
      severity: row.severity,
      status: row.status as IncidentStatus,
      type: row.type,
      region: row.region,
      regionId: row.regionId ?? null,
      source: row.source,
      summary: row.summary,
      latitude: row.latitude != null ? Number(row.latitude) : null,
      longitude: row.longitude != null ? Number(row.longitude) : null,
      occurredAt: row.occurredAt.toISOString(),
      reportedBy: ref(row.reportedBy),
      assignedTo: ref(row.assignedTo),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetail(
    row: IncidentRow,
    userMap: Map<string, UserRef>,
  ): IncidentDetail {
    return { ...this.toSummary(row, userMap), description: row.description };
  }
}

/** API receives lat/lng as numbers; the numeric column stores/returns strings. */
function numOrNull(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}
