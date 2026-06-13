import postgres from "postgres";
import type { Redis } from "ioredis";

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
 *
 * Optional `redis`: when provided, also wipes every key under
 * `cmc:auth:*` — covering both the P0.1 rate-limit counters AND the
 * P0.4 session-active cache. The rate-limit counters are keyed on the
 * loopback IP that supertest always uses, and the session-cache
 * entries persist for the configured TTL (60 s in tests); accumulated
 * state across tests would cause spurious 429s or stale session
 * lookups in later cases. Specs that drive `/auth/*` must pass the
 * redis client to keep cases isolated.
 */
export async function truncateAll(
  client: ReturnType<typeof ownerSql>,
  redis?: Redis,
): Promise<void> {
  await client.unsafe(`
    TRUNCATE TABLE
      audit_log,
      audit_chain_anchor,
      audit_export_cursor,
      outbox,
      consumed_events,
      projection_cursors,
      sessions,
      document_versions,
      documents,
      folders,
      gis_features,
      gis_layers,
      case_activity,
      cases,
      import_row_errors,
      import_jobs,
      chat_reactions,
      chat_messages,
      chat_channels,
      regions,
      users,
      tenants
    RESTART IDENTITY CASCADE
  `);

  if (redis) {
    // Wipe both auth state (rate-limit + session-active cache, `cmc:auth:*`)
    // and RBAC permission cache (`cmc:authz:*`) so cases don't bleed.
    await wipeKeys(redis, "cmc:auth:*");
    await wipeKeys(redis, "cmc:authz:*");
  }
}

/**
 * SCAN-and-DEL every key matching `pattern`. SCAN (not KEYS) so an
 * accidentally-large key space doesn't block Redis on test runs.
 */
async function wipeKeys(redis: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = next;
    if (batch.length > 0) {
      await redis.del(...batch);
    }
  } while (cursor !== "0");
}
