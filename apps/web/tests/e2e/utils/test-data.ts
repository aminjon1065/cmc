import postgres from "postgres";
import * as argon2 from "argon2";

export type TestTenant = { id: string; slug: string; name: string };
export type TestUser = {
  id: string;
  tenantId: string;
  email: string;
  password: string;
};

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/**
 * Owner-credentialed Postgres client. Bypasses RLS so spec files can set
 * up cross-tenant scenarios without going through the application.
 */
export function ownerSql() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    throw new Error("DATABASE_OWNER_URL is not set in the Playwright env");
  }
  return postgres(url, { max: 4, prepare: false });
}

/**
 * Wipe every test-scoped row before a spec runs. Cheaper than per-test
 * truncation and mirrors the api test pattern.
 */
export async function truncateAll(
  client: ReturnType<typeof ownerSql>,
): Promise<void> {
  await client.unsafe(`
    TRUNCATE TABLE
      audit_log, sessions, documents, users, tenants
    RESTART IDENTITY CASCADE
  `);
}

export async function createTenant(
  client: ReturnType<typeof ownerSql>,
  overrides: Partial<{ slug: string; name: string }> = {},
): Promise<TestTenant> {
  const slug = overrides.slug ?? uniq("pw-tenant");
  const name = overrides.name ?? `Tenant ${slug}`;
  const rows = await client<TestTenant[]>`
    INSERT INTO tenants (slug, name) VALUES (${slug}, ${name})
    RETURNING id, slug, name
  `;
  return rows[0]!;
}

export async function createUser(
  client: ReturnType<typeof ownerSql>,
  tenant: TestTenant,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<TestUser> {
  const email = (
    overrides.email ?? `${uniq("pw-u")}@playwright.test`
  ).toLowerCase();
  const name = overrides.name ?? `User ${email}`;
  const password = overrides.password ?? "playwright_test_pwd_8";

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
  });

  const rows = await client<{ id: string }[]>`
    INSERT INTO users (tenant_id, email, name, password_hash, is_active)
    VALUES (${tenant.id}, ${email}, ${name}, ${passwordHash}, true)
    RETURNING id
  `;

  return { id: rows[0]!.id, tenantId: tenant.id, email, password };
}

export async function createTenantWithUser(
  client: ReturnType<typeof ownerSql>,
  overrides: { tenantSlug?: string; email?: string; password?: string } = {},
): Promise<{ tenant: TestTenant; user: TestUser }> {
  const tenant = await createTenant(client, { slug: overrides.tenantSlug });
  const user = await createUser(client, tenant, {
    email: overrides.email,
    password: overrides.password,
  });
  return { tenant, user };
}
