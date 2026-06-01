import { Injectable } from "@nestjs/common";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";

/**
 * Consumer-side idempotency (P2.4 / ADR-0032). The bus is at-least-once, so a
 * consumer claims `(eventId, consumer)` before acting; the first claim wins, a
 * redelivery is a no-op. Runs privileged (the ledger is platform-internal).
 */
@Injectable()
export class EventDedupService {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  /**
   * Claim an event for a consumer. Returns true if this caller claimed it
   * (process it), false if it was already claimed (skip — already handled).
   */
  async claim(eventId: string, consumer: string): Promise<boolean> {
    return this.tenantDb.runPrivileged(async (tx) => {
      const inserted = await tx
        .insert(schema.consumedEvents)
        .values({ eventId, consumer })
        .onConflictDoNothing()
        .returning({ eventId: schema.consumedEvents.eventId });
      return inserted.length > 0;
    });
  }
}
