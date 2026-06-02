import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  type CreateRoleRequest,
  type Permission,
  type PermissionCatalogResponse,
  type RoleResponse,
  type UpdateRoleRequest,
  PERMISSION_CATALOG,
  permKey,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import {
  TenantDatabaseService,
  type TenantTx,
} from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { PermissionCacheService } from "../../common/permission-cache/permission-cache.service";

/**
 * RBAC resolution + administration (P1.1 / ADR-0019).
 *
 * `resolvePermissions` is the hot path (called by the AuthorizeGuard on every
 * protected request): cache-first, falling back to a join over
 * user_roles → role_permissions → permissions inside the request's
 * tenant-scoped transaction (RLS keeps it to the caller's tenant).
 *
 * Admin operations (assign/remove role) run privileged, audit the change, and
 * invalidate the affected user's cached permission set.
 */
@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name);
  private readonly cacheTtlSec: number;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly permCache: PermissionCacheService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.cacheTtlSec = config.get("RBAC_PERM_CACHE_TTL_SEC", { infer: true });
  }

  // ---------- hot path ----------

  /**
   * The set of permission strings the given user holds in the current tenant.
   * Cache-first; on miss, resolves from the DB (inside the active tenant tx)
   * and populates the cache.
   */
  async resolvePermissions(
    tenantId: string,
    userId: string,
  ): Promise<Set<Permission>> {
    const cached = await this.permCache.get(tenantId, userId);
    if (cached) return cached;

    // IMPORTANT: this runs from the AuthorizeGuard, which fires BEFORE the
    // TenantTransactionInterceptor opens the request's tenant tx (NestJS runs
    // guards before interceptors). So we open our OWN tenant-scoped tx via
    // runForTenant rather than relying on the ambient `.run()` scope (which
    // doesn't exist yet at guard time). RLS still confines the read to the
    // tenant.
    const rows = await this.tenantDb.runForTenant(tenantId, (tx) =>
      tx
        .select({
          domain: schema.permissions.domain,
          action: schema.permissions.action,
        })
        .from(schema.userRoles)
        .innerJoin(
          schema.rolePermissions,
          eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
        )
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(eq(schema.userRoles.userId, userId)),
    );

    const perms = new Set<Permission>(
      rows.map((r) => `${r.domain}:${r.action}` as Permission),
    );
    await this.permCache.set(tenantId, userId, perms, this.cacheTtlSec);
    return perms;
  }

  /** True iff the user holds the permission in the current tenant. */
  async hasPermission(
    tenantId: string,
    userId: string,
    perm: Permission,
  ): Promise<boolean> {
    const perms = await this.resolvePermissions(tenantId, userId);
    return perms.has(perm);
  }

  /**
   * Distinct user ids in the CURRENT tenant who hold `${domain}:${action}`
   * (reverse permission lookup). Runs in the ambient tenant tx — call inside a
   * `runForTenant`/request scope. Used to fan escalations out to e.g. the
   * `incident:resolve` holders (P3.2 / ADR-0046).
   */
  async usersWithPermission(domain: string, action: string): Promise<string[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .selectDistinct({ userId: schema.userRoles.userId })
        .from(schema.userRoles)
        .innerJoin(
          schema.rolePermissions,
          eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
        )
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(
          and(
            eq(schema.permissions.domain, domain),
            eq(schema.permissions.action, action),
          ),
        ),
    );
    return rows.map((r) => r.userId);
  }

  // ---------- queries ----------

  /** All roles in the current tenant, each with its permission strings. */
  async listRoles(): Promise<RoleResponse[]> {
    return this.tenantDb.run(async (tx) => {
      const roleRows = await tx
        .select()
        .from(schema.roles)
        .orderBy(schema.roles.slug);
      if (roleRows.length === 0) return [];

      const permRows = await tx
        .select({
          roleId: schema.rolePermissions.roleId,
          domain: schema.permissions.domain,
          action: schema.permissions.action,
        })
        .from(schema.rolePermissions)
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(
          inArray(
            schema.rolePermissions.roleId,
            roleRows.map((r) => r.id),
          ),
        );

      const byRole = new Map<string, Permission[]>();
      for (const p of permRows) {
        const arr = byRole.get(p.roleId) ?? [];
        arr.push(`${p.domain}:${p.action}` as Permission);
        byRole.set(p.roleId, arr);
      }

      return roleRows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: (byRole.get(r.id) ?? []).sort(),
      }));
    });
  }

  /** The roles assigned to a user in the current tenant. */
  async listUserRoles(userId: string): Promise<RoleResponse[]> {
    const allRoles = await this.listRoles();
    const assigned = await this.tenantDb.run((tx) =>
      tx
        .select({ roleId: schema.userRoles.roleId })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, userId)),
    );
    const assignedIds = new Set(assigned.map((a) => a.roleId));
    return allRoles.filter((r) => assignedIds.has(r.id));
  }

  // ---------- mutations ----------

  /** Assign a tenant role to a user. Audited; invalidates the user's cache. */
  async assignRole(userId: string, roleId: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();

    await this.tenantDb.run(async (tx) => {
      // Both the user and the role must belong to the caller's tenant. RLS
      // already filters to the tenant, so a missing row means cross-tenant or
      // nonexistent — treat as not found.
      const role = (
        await tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1)
      )[0];
      if (!role) throw new NotFoundException(`Role ${roleId} not found`);

      const user = (
        await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1)
      )[0];
      if (!user) throw new NotFoundException(`User ${userId} not found`);

      await tx
        .insert(schema.userRoles)
        .values({
          userId,
          roleId,
          tenantId: ctx.tenantId,
          grantedBy: ctx.userId,
        })
        .onConflictDoNothing();
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "rbac.role.assigned",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
      metadata: { roleId },
    });
    await this.permCache.del(ctx.tenantId, userId);
  }

  /** Remove a tenant role from a user. Audited; invalidates the user's cache. */
  async removeRole(userId: string, roleId: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();

    await this.tenantDb.run((tx) =>
      tx
        .delete(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, userId),
            eq(schema.userRoles.roleId, roleId),
          ),
        ),
    );

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "rbac.role.removed",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
      metadata: { roleId },
    });
    await this.permCache.del(ctx.tenantId, userId);
  }

  // ---------- guard helper ----------

  /**
   * Enforce that the current user holds every required permission. Throws
   * 403 + writes a durable denied-audit on the first missing one. Used by the
   * AuthorizeGuard.
   */
  async enforce(required: readonly Permission[]): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    const held = await this.resolvePermissions(ctx.tenantId, ctx.userId);
    const missing = required.find((p) => !held.has(p));
    if (missing) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorType: "user",
        action: "rbac.access.denied",
        resourceType: "permission",
        resourceId: missing,
        outcome: "denied",
        durable: true,
        metadata: { required: [...required] },
      });
      throw new ForbiddenException(`Missing permission: ${missing}`);
    }
  }

  // ---------- custom-role management (P1.4c / ADR-0022) ----------

  /** The global permission catalog, for the role editor. */
  getPermissionCatalog(): PermissionCatalogResponse {
    return {
      permissions: PERMISSION_CATALOG.map((p) => ({
        domain: p.domain,
        action: p.action,
        key: permKey(p),
        description: p.description,
      })),
    };
  }

  /** A single role (with permissions) in the current tenant, or null. */
  async getRole(id: string): Promise<RoleResponse | null> {
    return this.tenantDb.run(async (tx) => {
      const role = (
        await tx
          .select()
          .from(schema.roles)
          .where(eq(schema.roles.id, id))
          .limit(1)
      )[0];
      if (!role) return null;
      const permRows = await tx
        .select({
          domain: schema.permissions.domain,
          action: schema.permissions.action,
        })
        .from(schema.rolePermissions)
        .innerJoin(
          schema.permissions,
          eq(schema.permissions.id, schema.rolePermissions.permissionId),
        )
        .where(eq(schema.rolePermissions.roleId, id));
      return {
        id: role.id,
        slug: role.slug,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions: permRows
          .map((p) => `${p.domain}:${p.action}` as Permission)
          .sort(),
      };
    });
  }

  /** Create a custom (non-system) role with a set of catalog permissions. */
  async createRole(input: CreateRoleRequest): Promise<RoleResponse> {
    const ctx = this.tenantContext.requireCurrent();
    let roleId: string;
    try {
      roleId = await this.tenantDb.run(async (tx) => {
        const permissionIds = await this.resolvePermissionIds(
          tx,
          input.permissions,
        );
        const [role] = await tx
          .insert(schema.roles)
          .values({
            tenantId: ctx.tenantId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
          })
          .returning({ id: schema.roles.id });
        if (permissionIds.length > 0) {
          await tx.insert(schema.rolePermissions).values(
            permissionIds.map((permissionId) => ({
              roleId: role!.id,
              permissionId,
            })),
          );
        }
        return role!.id;
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          `A role with slug "${input.slug}" already exists`,
        );
      }
      throw err;
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "rbac.role.created",
      resourceType: "role",
      resourceId: roleId,
      outcome: "success",
      metadata: { slug: input.slug, permissions: input.permissions },
    });
    const role = await this.getRole(roleId);
    return role!;
  }

  /** Update a custom role's name/description/permissions. System roles are immutable. */
  async updateRole(
    id: string,
    changes: UpdateRoleRequest,
  ): Promise<RoleResponse> {
    const ctx = this.tenantContext.requireCurrent();
    const permsChanged = changes.permissions !== undefined;

    await this.tenantDb.run(async (tx) => {
      const role = (
        await tx
          .select()
          .from(schema.roles)
          .where(eq(schema.roles.id, id))
          .limit(1)
      )[0];
      if (!role) throw new NotFoundException("Role not found");
      if (role.isSystem) {
        throw new ForbiddenException("System roles cannot be modified");
      }

      if (changes.name !== undefined || changes.description !== undefined) {
        await tx
          .update(schema.roles)
          .set({
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.description !== undefined
              ? { description: changes.description }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(schema.roles.id, id));
      }

      if (changes.permissions !== undefined) {
        const permissionIds = await this.resolvePermissionIds(
          tx,
          changes.permissions,
        );
        await tx
          .delete(schema.rolePermissions)
          .where(eq(schema.rolePermissions.roleId, id));
        if (permissionIds.length > 0) {
          await tx.insert(schema.rolePermissions).values(
            permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
          );
        }
      }
    });

    // A permission change can affect every user holding the role — clear the
    // whole tenant's permission cache (bounded; the DB stays authoritative).
    if (permsChanged) {
      await this.permCache.delTenant(ctx.tenantId);
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "rbac.role.updated",
      resourceType: "role",
      resourceId: id,
      outcome: "success",
      metadata: { changes },
    });
    const role = await this.getRole(id);
    return role!;
  }

  /** Delete a custom role. System roles cannot be deleted. */
  async deleteRole(id: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();

    await this.tenantDb.run(async (tx) => {
      const role = (
        await tx
          .select()
          .from(schema.roles)
          .where(eq(schema.roles.id, id))
          .limit(1)
      )[0];
      if (!role) throw new NotFoundException("Role not found");
      if (role.isSystem) {
        throw new ForbiddenException("System roles cannot be deleted");
      }
      // FK cascade removes role_permissions + user_roles for this role.
      await tx.delete(schema.roles).where(eq(schema.roles.id, id));
    });

    // Any user who held this role just lost it — clear the tenant's cache.
    await this.permCache.delTenant(ctx.tenantId);

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "rbac.role.deleted",
      resourceType: "role",
      resourceId: id,
      outcome: "success",
    });
  }

  /**
   * Resolve permission strings (`domain:action`) to their catalog ids, inside
   * the given tx. Throws 400 listing any that aren't in the catalog.
   */
  private async resolvePermissionIds(
    tx: TenantTx,
    keys: string[],
  ): Promise<string[]> {
    if (keys.length === 0) return [];
    const rows = await tx
      .select({
        id: schema.permissions.id,
        domain: schema.permissions.domain,
        action: schema.permissions.action,
      })
      .from(schema.permissions);
    const idByKey = new Map(
      rows.map((p) => [`${p.domain}:${p.action}`, p.id]),
    );
    const unknown = [...new Set(keys)].filter((k) => !idByKey.has(k));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown permission(s): ${unknown.join(", ")}`,
      );
    }
    return [...new Set(keys)].map((k) => idByKey.get(k)!);
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
