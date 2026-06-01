import { and, eq } from "drizzle-orm";
import type { Database } from "@cmc/db";
import { schema } from "@cmc/db";
import {
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  type Permission,
} from "@cmc/contracts";

/**
 * RBAC seeding primitives (P1.1 / ADR-0019), shared by the dev seed script and
 * the e2e fixtures so both produce identical roles/permissions.
 *
 * `db` is the drizzle instance from `createDatabase().db` connected as the
 * owner (which bypasses RLS) — appropriate for bootstrap that writes
 * cross-tenant rows. Idempotent throughout.
 */
type Db = Database["db"];

/** Upsert the global permission catalog. Idempotent. */
export async function seedPermissionCatalog(db: Db): Promise<void> {
  for (const def of PERMISSION_CATALOG) {
    await db
      .insert(schema.permissions)
      .values({
        domain: def.domain,
        action: def.action,
        description: def.description,
      })
      .onConflictDoNothing();
  }
}

/**
 * Ensure the system roles (and their permission grants) exist for a tenant.
 * Idempotent. Returns a map of role slug → role id.
 */
export async function ensureSystemRolesForTenant(
  db: Db,
  tenantId: string,
): Promise<Map<string, string>> {
  await seedPermissionCatalog(db);

  const permRows = await db
    .select({
      id: schema.permissions.id,
      domain: schema.permissions.domain,
      action: schema.permissions.action,
    })
    .from(schema.permissions);
  const permIdByKey = new Map<Permission, string>(
    permRows.map((p) => [`${p.domain}:${p.action}` as Permission, p.id]),
  );
  const allPermIds = [...permIdByKey.values()];

  const roleIdBySlug = new Map<string, string>();

  for (const role of SYSTEM_ROLES) {
    await db
      .insert(schema.roles)
      .values({
        tenantId,
        slug: role.slug,
        name: role.name,
        description: role.description,
        isSystem: true,
      })
      .onConflictDoNothing();

    const found = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.tenantId, tenantId),
          eq(schema.roles.slug, role.slug),
        ),
      )
      .limit(1);
    const roleId = found[0]!.id;
    roleIdBySlug.set(role.slug, roleId);

    const grantIds =
      role.permissions === "*"
        ? allPermIds
        : role.permissions
            .map((p) => permIdByKey.get(p))
            .filter((id): id is string => Boolean(id));

    for (const permissionId of grantIds) {
      await db
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId })
        .onConflictDoNothing();
    }
  }

  return roleIdBySlug;
}

/** Assign a role (by id) to a user. Idempotent. */
export async function assignRoleToUser(
  db: Db,
  params: { userId: string; roleId: string; tenantId: string },
): Promise<void> {
  await db
    .insert(schema.userRoles)
    .values({
      userId: params.userId,
      roleId: params.roleId,
      tenantId: params.tenantId,
    })
    .onConflictDoNothing();
}
