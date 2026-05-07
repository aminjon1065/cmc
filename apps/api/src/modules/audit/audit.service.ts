import { Inject, Injectable, Logger } from "@nestjs/common";
import { schema, type Database } from "@cmc/db";
import { DB } from "../database/database.module";

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditRecordInput = {
  /** Tenant scope of the action (omit for tenant-less actions like login attempts). */
  tenantId?: string | null;
  /** Who performed the action. Null for unauthenticated attempts. */
  actorId?: string | null;
  actorType: "user" | "service" | "system" | "anonymous";
  /** Verb-noun, e.g. "user.login", "document.create". */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  /** Free-form structured detail. Avoid putting raw secrets here. */
  metadata?: Record<string, unknown> | null;
};

/**
 * Append-only audit logger. Per ToR §3.15 every state-changing action AND
 * every authentication outcome lands here. Hash chaining is added in a later
 * iteration; for now `prev_event_hash` and `this_hash` are left null and the
 * column is reserved.
 *
 * Failures inside the audit writer are logged but do NOT abort the originating
 * request — losing visibility on a write is bad, but failing the user's
 * action because the audit DB hiccupped is worse. A future refinement is to
 * route through the outbox table so audit writes are transactional with the
 * domain mutation.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DB) private readonly database: Database) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.database.db.insert(schema.auditLog).values({
        tenantId: input.tenantId ?? null,
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        outcome: input.outcome,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata: input.metadata ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${input.actorType}/${input.action}/${input.resourceType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
