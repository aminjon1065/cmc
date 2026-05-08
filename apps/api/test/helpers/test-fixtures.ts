import * as argon2 from "argon2";
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

/**
 * Convenience: create a tenant + admin user in one call.
 */
export async function createTenantWithAdmin(
  sql: ReturnType<typeof ownerSql>,
  overrides: { tenantSlug?: string; email?: string; password?: string } = {},
): Promise<{ tenant: TestTenant; user: TestUser }> {
  const tenant = await createTenant(sql, { slug: overrides.tenantSlug });
  const user = await createUser(sql, tenant, {
    email: overrides.email,
    password: overrides.password,
  });
  return { tenant, user };
}
