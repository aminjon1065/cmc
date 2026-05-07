import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, isNull, and } from "drizzle-orm";
import { schema, type Database } from "@cmc/db";
import { DB } from "../database/database.module";

@Injectable()
export class TenantsService {
  constructor(@Inject(DB) private readonly database: Database) {}

  async findById(id: string) {
    const rows = await this.database.db
      .select()
      .from(schema.tenants)
      .where(and(eq(schema.tenants.id, id), isNull(schema.tenants.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findBySlug(slug: string) {
    const rows = await this.database.db
      .select()
      .from(schema.tenants)
      .where(
        and(eq(schema.tenants.slug, slug), isNull(schema.tenants.deletedAt)),
      )
      .limit(1);
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
