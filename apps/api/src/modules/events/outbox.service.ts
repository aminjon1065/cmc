import { Injectable } from "@nestjs/common";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { RequestContextService } from "../../common/request-context/request-context.service";

export type PublishEventInput = {
  /** Tenant scope; null for platform/system events. */
  tenantId: string | null;
  /** Aggregate type — a dot-free NATS subject token, e.g. `incident`. */
  aggregateType: string;
  aggregateId: string;
  /** Bare event verb — a dot-free NATS subject token, e.g. `created`. */
  eventType: string;
  version?: number;
  payload: Record<string, unknown>;
  /** The event id that caused this one, if any. */
  causationId?: string | null;
  traceId?: string | null;
};

/**
 * Transactional-outbox producer (P2.1 / ADR-0031).
 *
 * `publish()` appends an event to the `outbox` table. The crucial property:
 * when called inside a request/handler transaction (the common case — guards +
 * the global tenant-tx interceptor have already opened one, exposed via ALS),
 * the insert joins THAT transaction, so the event and the state-change it
 * describes commit or roll back together. No dual-write, no lost or phantom
 * events. With no ambient tx (background jobs, system events), it opens its own
 * privileged transaction. A separate relay (P2.1b) ships rows to NATS.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly requestContext: RequestContextService,
  ) {}

  /** Append an event; returns its id (the dedup key downstream). */
  async publish(input: PublishEventInput): Promise<string> {
    const row = {
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      version: input.version ?? 1,
      payload: input.payload,
      causationId: input.causationId ?? null,
      // Thread the active trace so a consumer can correlate back to the
      // request that produced the event (same pattern as audit rows).
      traceId: input.traceId ?? this.requestContext.getTraceId() ?? null,
    };

    const tx = this.tenantDb.getCurrentTx();
    if (tx) {
      const [r] = await tx
        .insert(schema.outbox)
        .values(row)
        .returning({ id: schema.outbox.id });
      return r!.id;
    }
    return this.tenantDb.runPrivileged(async (ptx) => {
      const [r] = await ptx
        .insert(schema.outbox)
        .values(row)
        .returning({ id: schema.outbox.id });
      return r!.id;
    });
  }
}
