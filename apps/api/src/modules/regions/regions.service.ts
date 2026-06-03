import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { Region } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";

type Actor = { userId: string; tenantId: string };
type RegionRow = typeof schema.regions.$inferSelect;

/**
 * Regions (P4.6 / ADR-0064). CRUD over the per-tenant region catalog; RLS
 * scopes every read/write to the caller's tenant, so a cross-tenant id is a
 * clean 404. The per-region *visibility* enforcement on operational data lives
 * with the incidents/cases services (P4.6b); this service owns the catalog, and
 * user→region assignment rides on the existing admin-users surface.
 */
@Injectable()
export class RegionsService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
  ) {}

  private toRegion(r: RegionRow): Region {
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async list(): Promise<Region[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx.select().from(schema.regions).orderBy(schema.regions.name),
    );
    return rows.map((r) => this.toRegion(r));
  }

  async create(
    actor: Actor,
    input: { code: string; name: string },
  ): Promise<Region> {
    let row: RegionRow;
    try {
      const inserted = await this.tenantDb.run((tx) =>
        tx
          .insert(schema.regions)
          .values({
            tenantId: actor.tenantId,
            code: input.code,
            name: input.name,
          })
          .returning(),
      );
      row = inserted[0]!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A region with code "${input.code}" already exists`,
        );
      }
      throw err;
    }
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "region.created",
      resourceType: "region",
      resourceId: row.id,
      outcome: "success",
      metadata: { code: row.code, name: row.name },
    });
    return this.toRegion(row);
  }

  async update(
    actor: Actor,
    id: string,
    input: { name: string },
  ): Promise<Region> {
    const updated = await this.tenantDb.run((tx) =>
      tx
        .update(schema.regions)
        .set({ name: input.name, updatedAt: sql`now()` })
        .where(eq(schema.regions.id, id))
        .returning(),
    );
    const row = updated[0];
    if (!row) throw new NotFoundException("Region not found");
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "region.updated",
      resourceType: "region",
      resourceId: row.id,
      outcome: "success",
      metadata: { name: row.name },
    });
    return this.toRegion(row);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const existing = await this.tenantDb.run((tx) =>
      tx
        .select({ id: schema.regions.id })
        .from(schema.regions)
        .where(eq(schema.regions.id, id))
        .limit(1),
    );
    if (existing.length === 0) throw new NotFoundException("Region not found");

    // Don't orphan users silently — require reassignment first.
    const assigned = await this.tenantDb.run((tx) =>
      tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.regionId, id))
        .limit(1),
    );
    if (assigned.length > 0) {
      throw new ConflictException(
        "Reassign this region's users before deleting it",
      );
    }

    await this.tenantDb.run((tx) =>
      tx.delete(schema.regions).where(eq(schema.regions.id, id)),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "region.deleted",
      resourceType: "region",
      resourceId: id,
      outcome: "success",
    });
  }
}

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
