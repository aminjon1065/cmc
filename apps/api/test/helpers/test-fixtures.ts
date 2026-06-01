import * as argon2 from "argon2";
import {
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  type Permission,
} from "@cmc/contracts";
import type { ownerSql } from "./test-db";

/**
 * Owner-driven fixture helpers — they bypass RLS and the application's
 * tenant scope to set up scenarios across tenants. Don't import these
 * from production code.
 */

export type TestTenant = {
  id: string;
  slug: string;
  name: string;
};

export type TestUser = {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  password: string; // plaintext, kept here so the test can call /auth/login
};

let counter = 0;

function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function createTenant(
  sql: ReturnType<typeof ownerSql>,
  overrides: Partial<{ slug: string; name: string }> = {},
): Promise<TestTenant> {
  const slug = overrides.slug ?? uniq("tenant");
  const name = overrides.name ?? `Tenant ${slug}`;
  const rows = await sql<TestTenant[]>`
    INSERT INTO tenants (slug, name)
    VALUES (${slug}, ${name})
    RETURNING id, slug, name
  `;
  return rows[0]!;
}

export async function createUser(
  sql: ReturnType<typeof ownerSql>,
  tenant: TestTenant,
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<TestUser> {
  const email = (overrides.email ?? `${uniq("u")}@test.local`).toLowerCase();
  const name = overrides.name ?? `User ${email}`;
  const password = overrides.password ?? "test_password_12345";

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
  });

  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, name, password_hash, is_active)
    VALUES (${tenant.id}, ${email}, ${name}, ${passwordHash}, true)
    RETURNING id
  `;

  return {
    id: rows[0]!.id,
    tenantId: tenant.id,
    email,
    name,
    password,
  };
}

// ---------- RBAC fixtures (P1.1) ----------

/** Idempotently insert the global permission catalog. */
export async function seedPermissions(
  sql: ReturnType<typeof ownerSql>,
): Promise<void> {
  for (const def of PERMISSION_CATALOG) {
    await sql`
      INSERT INTO permissions (domain, action, description)
      VALUES (${def.domain}, ${def.action}, ${def.description})
      ON CONFLICT (domain, action) DO NOTHING
    `;
  }
}

/**
 * Ensure a system role exists for a tenant with its permission grants, and
 * return its id. Idempotent. Seeds the catalog first.
 */
export async function ensureSystemRole(
  sql: ReturnType<typeof ownerSql>,
  tenantId: string,
  slug: (typeof SYSTEM_ROLES)[number]["slug"],
): Promise<string> {
  await seedPermissions(sql);
  const def = SYSTEM_ROLES.find((r) => r.slug === slug)!;

  await sql`
    INSERT INTO roles (tenant_id, slug, name, description, is_system)
    VALUES (${tenantId}, ${def.slug}, ${def.name}, ${def.description}, true)
    ON CONFLICT (tenant_id, slug) DO NOTHING
  `;
  const roleRows = await sql<{ id: string }[]>`
    SELECT id FROM roles WHERE tenant_id = ${tenantId} AND slug = ${def.slug} LIMIT 1
  `;
  const roleId = roleRows[0]!.id;

  // Resolve the permission ids to grant.
  const keys: Permission[] =
    def.permissions === "*"
      ? PERMISSION_CATALOG.map((p) => `${p.domain}:${p.action}` as Permission)
      : [...def.permissions];
  for (const key of keys) {
    const parts = key.split(":");
    const domain = parts[0]!;
    const action = parts[1]!;
    await sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${roleId}, p.id FROM permissions p
       WHERE p.domain = ${domain} AND p.action = ${action}
      ON CONFLICT DO NOTHING
    `;
  }
  return roleId;
}

/**
 * Ensure ALL system roles exist for a tenant (matches the production seed's
 * `ensureSystemRolesForTenant`). Returns slug → id. Idempotent.
 */
export async function ensureAllSystemRoles(
  sql: ReturnType<typeof ownerSql>,
  tenantId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    map.set(def.slug, await ensureSystemRole(sql, tenantId, def.slug));
  }
  return map;
}

/** Assign a role to a user (idempotent). */
export async function assignRole(
  sql: ReturnType<typeof ownerSql>,
  params: { userId: string; roleId: string; tenantId: string },
): Promise<void> {
  await sql`
    INSERT INTO user_roles (user_id, role_id, tenant_id)
    VALUES (${params.userId}, ${params.roleId}, ${params.tenantId})
    ON CONFLICT (user_id, role_id) DO NOTHING
  `;
}

/** Grant a system role to a user by slug (ensures the role exists first). */
export async function grantSystemRole(
  sql: ReturnType<typeof ownerSql>,
  user: TestUser,
  slug: (typeof SYSTEM_ROLES)[number]["slug"],
): Promise<string> {
  const roleId = await ensureSystemRole(sql, user.tenantId, slug);
  await assignRole(sql, {
    userId: user.id,
    roleId,
    tenantId: user.tenantId,
  });
  return roleId;
}

/**
 * Convenience: create a tenant + admin user in one call. The admin is granted
 * `tenant_admin` by default (P1.1) so existing tests that rely on full access
 * keep working; pass `grantAdminRole: false` to create a role-less user.
 */
export async function createTenantWithAdmin(
  sql: ReturnType<typeof ownerSql>,
  overrides: {
    tenantSlug?: string;
    email?: string;
    password?: string;
    grantAdminRole?: boolean;
  } = {},
): Promise<{ tenant: TestTenant; user: TestUser }> {
  const tenant = await createTenant(sql, { slug: overrides.tenantSlug });
  const user = await createUser(sql, tenant, {
    email: overrides.email,
    password: overrides.password,
  });
  // Seed the full system-role set for the tenant (matches production seed),
  // then grant tenant_admin to the user unless opted out.
  const roleIds = await ensureAllSystemRoles(sql, tenant.id);
  if (overrides.grantAdminRole !== false) {
    await assignRole(sql, {
      userId: user.id,
      roleId: roleIds.get("tenant_admin")!,
      tenantId: tenant.id,
    });
  }
  return { tenant, user };
}
