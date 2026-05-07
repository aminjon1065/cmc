import { Inject, Injectable } from "@nestjs/common";
import { eq, and, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@cmc/db";
import { DB } from "../database/database.module";

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly database: Database) {}

  /**
   * Find an active user by email within a tenant. Email uniqueness is
   * scoped per tenant — the same address can exist in two tenants.
   */
  async findByEmail(tenantId: string, email: string) {
    const rows = await this.database.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, tenantId),
          eq(schema.users.email, email.toLowerCase()),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Cross-tenant email lookup. Used during login when the user has not yet
   * told us which tenant they belong to. Returns at most one user since
   * (tenant_id, email) is unique per tenant — but multiple users with the
   * same email could exist in different tenants. Caller picks one (e.g.,
   * by domain in email or by an extra field).
   */
  async findActiveByEmailGlobal(email: string) {
    const rows = await this.database.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.email, email.toLowerCase()),
          eq(schema.users.isActive, true),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(2);
    return rows;
  }

  async findById(id: string) {
    const rows = await this.database.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async markLoggedIn(id: string): Promise<void> {
    await this.database.db
      .update(schema.users)
      .set({ lastLoginAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(schema.users.id, id));
  }
}
