import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@cmc/db";
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

  private toRow(input: AuditRecordInput) {
    // If the caller didn't specify request_id, pull it from the active
    // ALS scope. This makes every audit row auto-correlatable with the
    // request that produced it without every call site having to know
    // about the request-context plumbing.
    const requestId = input.requestId ?? this.requestContext.getRequestId() ?? null;
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
      traceId: input.traceId ?? null,
      metadata: input.metadata ?? null,
    };
  }
}
