import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  MonitoringEvent,
  MonitoringReplayResponse,
  MonitoringSummary,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";

/** Statuses that count as "active" (non-terminal) for the wall. */
const TERMINAL = ["resolved", "closed", "cancelled"];

type AuditRow = typeof schema.auditLog.$inferSelect;

/**
 * Operational Monitoring Center aggregation (P4.3 / ADR-0062). Pure Postgres
 * (no ClickHouse dependency) so the wall + replay are always available and
 * e2e-testable. Everything runs in the request tenant transaction (RLS-scoped).
 */
@Injectable()
export class MonitoringService {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  private toEvent(r: AuditRow): MonitoringEvent {
    return {
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId ?? null,
      actorId: r.actorId ?? null,
      outcome: r.outcome,
    };
  }

  /** Live snapshot for the wall: polled by the browser. */
  async summary(): Promise<MonitoringSummary> {
    return this.tenantDb.run(async (tx) => {
      const live = and(isNull(schema.incidents.deletedAt));

      const byStatusRows = await tx
        .select({ status: schema.incidents.status, n: count() })
        .from(schema.incidents)
        .where(live)
        .groupBy(schema.incidents.status);

      const bySeverityRows = await tx
        .select({ severity: schema.incidents.severity, n: count() })
        .from(schema.incidents)
        .where(live)
        .groupBy(schema.incidents.severity);

      const byStatus: Record<string, number> = {};
      let active = 0;
      for (const r of byStatusRows) {
        byStatus[r.status] = r.n;
        if (!TERMINAL.includes(r.status)) active += r.n;
      }
      const bySeverity: Record<string, number> = {};
      for (const r of bySeverityRows) bySeverity[String(r.severity)] = r.n;

      const recentIncidents = await tx
        .select({
          id: schema.incidents.id,
          summary: schema.incidents.summary,
          severity: schema.incidents.severity,
          status: schema.incidents.status,
          createdAt: schema.incidents.createdAt,
        })
        .from(schema.incidents)
        .where(live)
        .orderBy(desc(schema.incidents.createdAt))
        .limit(8);

      const recentEvents = await tx
        .select()
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.occurredAt), desc(schema.auditLog.seq))
        .limit(20);

      const [openRooms] = await tx
        .select({ n: count() })
        .from(schema.videoRooms)
        .where(eq(schema.videoRooms.status, "open"));

      return {
        generatedAt: new Date().toISOString(),
        incidents: { active, byStatus, bySeverity },
        recentIncidents: recentIncidents.map((r) => ({
          id: r.id,
          summary: r.summary,
          severity: r.severity,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        recentEvents: recentEvents.map((r) => this.toEvent(r)),
        videoRoomsOpen: openRooms?.n ?? 0,
      };
    });
  }

  /** Operational action timeline over [from,to], ascending, capped. */
  async replay(
    from: Date,
    to: Date,
    limit: number,
  ): Promise<MonitoringReplayResponse> {
    const events = await this.tenantDb.run(async (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            gte(schema.auditLog.occurredAt, sql`${from.toISOString()}::timestamptz`),
            lte(schema.auditLog.occurredAt, sql`${to.toISOString()}::timestamptz`),
          ),
        )
        .orderBy(asc(schema.auditLog.occurredAt), asc(schema.auditLog.seq))
        .limit(limit),
    );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      events: events.map((r) => this.toEvent(r)),
    };
  }
}
