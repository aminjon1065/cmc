import { Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { AuditLogListResponse } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { RequestContextService } from "../../common/request-context/request-context.service";

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditRecordInput = {
  /** Tenant scope of the action (omit for tenant-less events like login attempts). */
  tenantId?: string | null;
  actorId?: string | null;
  actorType: "user" | "service" | "system" | "anonymous";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Force the row to commit independently of the surrounding request
   * transaction. Use for audits of events that are themselves the failure
   * being recorded (e.g. login denial that throws 401) — without this the
   * audit row would roll back with the response.
   */
  durable?: boolean;
};

/**
 * Append-only audit logger.
 *
 * Writes go through whichever transaction is currently active — privileged,
 * tenant-scoped, or freshly opened. RLS on `audit_log` allows inserts from
 * any context; reads are restricted to the same tenant or to privileged
 * code (e.g. compliance tooling).
 *
 * Failures inside the audit writer are logged but do NOT abort the calling
 * request — losing visibility on a single audit row is bad, but failing
 * the user's action because the audit insert hiccuped is worse. The
 * outbox-backed reliable writer arrives in a later iteration.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly requestContext: RequestContextService,
  ) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      const tx = this.tenantDb.getCurrentTx();
      if (tx && !input.durable) {
        // Piggyback on the caller's transaction — atomic with the action
        // it audits (great for success paths).
        await tx.insert(schema.auditLog).values(this.toRow(input));
      } else {
        // No surrounding tx, OR caller asked for durability — write in a
        // fresh privileged transaction so the row survives even if the
        // surrounding request rolls back. Used for audits of failure
        // events that also throw.
        await this.tenantDb.runPrivileged(async (privTx) => {
          await privTx.insert(schema.auditLog).values(this.toRow(input));
        });
      }
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${input.actorType}/${input.action}/${input.resourceType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read-only, RLS-scoped audit-log list for the audit viewer (gated
   * `audit:read`). Newest-first by `seq` with keyset pagination (`before`) and
   * optional action / resourceType / outcome filters. Returns a safe subset —
   * no raw chain hashes.
   */
  async listLog(query: {
    action?: string;
    resourceType?: string;
    outcome?: string;
    before?: number;
    limit?: number;
  }): Promise<AuditLogListResponse> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    return this.tenantDb.run(async (tx) => {
      const where = and(
        query.action ? eq(schema.auditLog.action, query.action) : undefined,
        query.resourceType
          ? eq(schema.auditLog.resourceType, query.resourceType)
          : undefined,
        query.outcome ? eq(schema.auditLog.outcome, query.outcome) : undefined,
        query.before ? lt(schema.auditLog.seq, query.before) : undefined,
      );
      const rows = await tx
        .select()
        .from(schema.auditLog)
        .where(where)
        .orderBy(desc(schema.auditLog.seq))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        entries: page.map((r) => ({
          id: r.id,
          seq: r.seq,
          occurredAt: r.occurredAt.toISOString(),
          actorId: r.actorId ?? null,
          actorType: r.actorType,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId ?? null,
          outcome: r.outcome,
          requestId: r.requestId ?? null,
          sealed: r.sealedAt != null,
        })),
        nextCursor: hasMore ? page[page.length - 1]!.seq : null,
      };
    });
  }

  private toRow(input: AuditRecordInput) {
    // If the caller didn't specify request_id, pull it from the active
    // ALS scope. This makes every audit row auto-correlatable with the
    // request that produced it without every call site having to know
    // about the request-context plumbing.
    const requestId = input.requestId ?? this.requestContext.getRequestId() ?? null;
    // Same ALS-default pattern as request_id: pull the captured OTEL
    // trace id (P0.6 / ADR-0013) so every audit row joins to its trace
    // without each call site knowing about the tracing plumbing.
    const traceId =
      input.traceId ?? this.requestContext.getTraceId() ?? null;
    return {
      tenantId: input.tenantId ?? null,
      actorId: input.actorId ?? null,
      actorType: input.actorType,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId,
      traceId,
      metadata: input.metadata ?? null,
    };
  }
}
