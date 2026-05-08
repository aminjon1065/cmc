import { Injectable } from "@nestjs/common";
import { eq, and, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";

@Injectable()
export class UsersService {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  /**
   * Find an active user by email *within the current tenant*. Email
   * uniqueness is per-tenant.
   */
  async findByEmail(email: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.email, email.toLowerCase()),
            isNull(schema.users.deletedAt),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Cross-tenant lookup. Used during login when the user has not yet
   * told us which tenant they belong to. Caller MUST be inside a
   * privileged transaction (RLS bypass) — the auth service is the only
   * legitimate caller today.
   */
  async findActiveByEmailGlobal(email: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.email, email.toLowerCase()),
            eq(schema.users.isActive, true),
            isNull(schema.users.deletedAt),
          ),
        )
        .limit(2),
    );
    return rows;
  }

  async findById(id: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async markLoggedIn(id: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.users)
        .set({ lastLoginAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.users.id, id)),
    );
  }
}
