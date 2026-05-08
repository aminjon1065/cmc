import postgres from "postgres";

/**
 * Owner-credentialed Postgres client for test fixtures.
 *
 * Tests create rows that span tenants (e.g., setting up Tenant A and
 * Tenant B for an isolation test) — that requires either the cmc owner
 * or `app.bypass_rls = 'on'`. Using the owner directly is cheapest.
 *
 * Returns a single client; caller decides when to close it. For helpers
 * that are called repeatedly within one test, reuse the client to avoid
 * connection churn.
 */
export function ownerSql() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    throw new Error(
      "DATABASE_OWNER_URL is not set. Did the test env loader run?",
    );
  }
  return postgres(url, { max: 4, prepare: false });
}

/**
 * TRUNCATE every test-scoped table between test cases. The owner role
 * bypasses RLS so the TRUNCATE wipes cross-tenant rows in one shot.
 *
 * `__drizzle_migrations` is NOT touched — that would force re-running
 * migrations every test.
 *
 * `RESTART IDENTITY` and `CASCADE` clear sequences and FK-dependent rows.
 */
export async function truncateAll(
  client: ReturnType<typeof ownerSql>,
): Promise<void> {
  await client.unsafe(`
    TRUNCATE TABLE
      audit_log,
      sessions,
      documents,
      users,
      tenants
    RESTART IDENTITY CASCADE
  `);
}
