import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { UserRoleRef, UserSummary } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { SessionsService } from "../auth/sessions.service";
import { AuditService } from "../audit/audit.service";

/** Actor attribution carried into the admin-mutation audit rows. */
type AdminActor = {
  actorId: string;
  tenantId: string;
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

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

  /**
   * Overwrite a user's password hash (P1.3 password reset). Runs in whatever
   * ambient scope the caller established — the self-service reset wraps this in
   * a privileged tx (no tenant context yet), the admin flow in the admin's
   * tenant tx. Only the hash is ever passed in; hashing is the caller's job.
   */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.users)
        .set({ passwordHash, updatedAt: sql`now()` })
        .where(eq(schema.users.id, id)),
    );
  }

  // ---------- admin user management (P1.4b / ADR-0022) ----------

  /** Every non-deleted user in the current tenant, each with its roles. */
  async listUsers(): Promise<UserSummary[]> {
    return this.tenantDb.run(async (tx) => {
      const userRows = await tx
        .select()
        .from(schema.users)
        .where(isNull(schema.users.deletedAt))
        .orderBy(schema.users.createdAt);
      if (userRows.length === 0) return [];

      const roleRows = await tx
        .select({
          userId: schema.userRoles.userId,
          id: schema.roles.id,
          slug: schema.roles.slug,
          name: schema.roles.name,
        })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(
          inArray(
            schema.userRoles.userId,
            userRows.map((u) => u.id),
          ),
        );

      const byUser = new Map<string, UserRoleRef[]>();
      for (const r of roleRows) {
        const arr = byUser.get(r.userId) ?? [];
        arr.push({ id: r.id, slug: r.slug, name: r.name });
        byUser.set(r.userId, arr);
      }
      return userRows.map((u) => this.toSummary(u, byUser.get(u.id) ?? []));
    });
  }

  /** A single non-deleted user (with roles) in the current tenant, or null. */
  async getUserDetail(id: string): Promise<UserSummary | null> {
    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
        .limit(1);
      const user = rows[0];
      if (!user) return null;

      const roleRows = await tx
        .select({
          id: schema.roles.id,
          slug: schema.roles.slug,
          name: schema.roles.name,
        })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(eq(schema.userRoles.userId, id));
      return this.toSummary(user, roleRows);
    });
  }

  /**
   * Create a PASSWORDLESS user in the current tenant (P1.4b). They can't log in
   * until an admin triggers a password reset (P1.3) — there's no email channel
   * yet. Duplicate email → 409. Role grants are the controller's job.
   */
  async createUser(input: {
    email: string;
    name: string;
    actor: AdminActor;
  }): Promise<UserSummary> {
    const email = input.email.toLowerCase();
    let created: typeof schema.users.$inferSelect;
    try {
      created = await this.tenantDb.run(async (tx) => {
        const [row] = await tx
          .insert(schema.users)
          .values({
            tenantId: input.actor.tenantId,
            email,
            name: input.name,
            passwordHash: null,
            isActive: true,
          })
          .returning();
        return row!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A user with that email already exists");
      }
      throw err;
    }

    await this.audit.record({
      tenantId: input.actor.tenantId,
      actorId: input.actor.actorId,
      actorType: "user",
      action: "user.created",
      resourceType: "user",
      resourceId: created.id,
      outcome: "success",
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      metadata: { email },
    });
    return this.toSummary(created, []);
  }

  /**
   * Update a user's name and/or active status. Deactivation revokes all their
   * sessions (immediate eviction). An admin cannot deactivate themselves.
   */
  async updateUser(
    id: string,
    changes: { name?: string; isActive?: boolean; regionId?: string | null },
    actor: AdminActor,
  ): Promise<UserSummary> {
    const existing = await this.getUserDetail(id);
    if (!existing) throw new NotFoundException("User not found");

    const deactivating = changes.isActive === false && existing.isActive;
    if (deactivating && id === actor.actorId) {
      throw new ForbiddenException("You cannot deactivate your own account");
    }

    // A non-null region must be a real region in this tenant (RLS-scoped, so a
    // cross-tenant region id is a clean 404). null clears the assignment.
    const regionProvided = changes.regionId !== undefined;
    if (regionProvided && changes.regionId !== null) {
      const found = await this.tenantDb.run((tx) =>
        tx
          .select({ id: schema.regions.id })
          .from(schema.regions)
          .where(eq(schema.regions.id, changes.regionId!))
          .limit(1),
      );
      if (found.length === 0) throw new NotFoundException("Region not found");
    }

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.users)
        .set({
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.isActive !== undefined
            ? { isActive: changes.isActive }
            : {}),
          ...(regionProvided ? { regionId: changes.regionId } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.users.id, id)),
    );

    if (deactivating) {
      await this.sessions.revokeAllForUser(id, "admin");
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      actorType: "user",
      action: deactivating ? "user.deactivated" : "user.updated",
      resourceType: "user",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { changes },
    });

    const updated = await this.getUserDetail(id);
    return updated!;
  }

  /**
   * Soft-delete a user: set `deleted_at`, deactivate, and revoke sessions. An
   * admin cannot delete themselves.
   */
  async softDeleteUser(id: string, actor: AdminActor): Promise<void> {
    if (id === actor.actorId) {
      throw new ForbiddenException("You cannot delete your own account");
    }
    const existing = await this.getUserDetail(id);
    if (!existing) throw new NotFoundException("User not found");

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.users)
        .set({
          deletedAt: sql`now()`,
          isActive: false,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.users.id, id)),
    );
    await this.sessions.revokeAllForUser(id, "admin");

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.actorId,
      actorType: "user",
      action: "user.deleted",
      resourceType: "user",
      resourceId: id,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    });
  }

  private toSummary(
    user: typeof schema.users.$inferSelect,
    roles: UserRoleRef[],
  ): UserSummary {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isActive: user.isActive,
      hasPassword: !!user.passwordHash,
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      createdAt: user.createdAt.toISOString(),
      regionId: user.regionId ?? null,
      roles,
    };
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
