import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";

/**
 * The `tenants` table is special: it is the *source* of tenant identity, so
 * RLS does not filter it by tenant_id (there is no tenant_id column).
 * Lookups are by id or slug; access control is enforced at the application
 * level (only privileged paths and the user's own tenant lookup).
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
  ) {}

  async findById(id: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.tenants)
        .where(and(eq(schema.tenants.id, id), isNull(schema.tenants.deletedAt)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async findBySlug(slug: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.tenants)
        .where(
          and(eq(schema.tenants.slug, slug), isNull(schema.tenants.deletedAt)),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async getByIdOrFail(id: string) {
    const tenant = await this.findById(id);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${id} not found`);
    }
    return tenant;
  }

  /**
   * Rename a tenant (P1.4d). The id is always the caller's own tenant (from the
   * auth context, never user input), so an admin can only ever rename their own
   * tenant — the `tenants` table has no RLS, but the application boundary does.
   */
  async updateTenant(
    id: string,
    changes: { name: string },
    actor: { actorId: string; ip?: string | null; userAgent?: string | null },
  ): Promise<typeof schema.tenants.$inferSelect> {
    const updated = await this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .update(schema.tenants)
        .set({ name: changes.name, updatedAt: sql`now()` })
        .where(and(eq(schema.tenants.id, id), isNull(schema.tenants.deletedAt)))
        .returning();
      return row;
    });
    if (!updated) throw new NotFoundException(`Tenant ${id} not found`);

    await this.audit.record({
      tenantId: id,
      actorId: actor.actorId,
      actorType: "user",
      action: "tenant.updated",
      resourceType: "tenant",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { name: changes.name },
    });
    return updated;
  }
}
