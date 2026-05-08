import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";

/**
 * The `tenants` table is special: it is the *source* of tenant identity, so
 * RLS does not filter it by tenant_id (there is no tenant_id column).
 * Lookups are by id or slug; access control is enforced at the application
 * level (only privileged paths and the user's own tenant lookup).
 */
@Injectable()
export class TenantsService {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

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
}
