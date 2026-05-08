/**
 * Playwright global setup — runs once before any browser test starts.
 *
 * Idempotently bootstraps `cmc_test` (creates DB, applies migrations,
 * grants cmc_app). Safe to run alongside the API's Jest e2e suite —
 * both global-setups land on the same DB and are no-ops on a warm
 * volume.
 *
 * After this returns, the spec files create their own per-test
 * tenants/users via tests/e2e/utils/test-data.ts.
 */
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export default async function globalSetup(): Promise<void> {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) {
    throw new Error(
      "DATABASE_OWNER_URL is required for Playwright global setup",
    );
  }

  // 1. CREATE DATABASE if missing — connect to the postgres admin DB.
  const adminUrl = ownerUrl.replace(/\/[^/]+$/, "/postgres");
  const dbName = new URL(ownerUrl).pathname.slice(1);

  const admin = postgres(adminUrl, { max: 1, prepare: false });
  try {
    const exists =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await admin.unsafe(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await admin.end({ timeout: 2 });
  }

  // 2. cmc_app role + db-level grants (idempotent).
  const owner = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await owner.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmc_app') THEN
          CREATE ROLE cmc_app
            LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
            NOREPLICATION NOBYPASSRLS
            PASSWORD 'cmc_app_dev_password_change_me';
        END IF;
      END $$;
    `);
    await owner.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO cmc_app`);
    await owner.unsafe(`GRANT USAGE ON SCHEMA public TO cmc_app`);
  } finally {
    await owner.end({ timeout: 2 });
  }

  // 3. Apply migrations.
  const migrator = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await migrate(drizzle(migrator), {
      migrationsFolder: resolve(
        __dirname,
        "../../../../packages/db/migrations",
      ),
    });
  } finally {
    await migrator.end({ timeout: 2 });
  }

  // 4. Now-table-level grants + default privileges.
  const grants = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await grants.unsafe(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO cmc_app;
      GRANT USAGE, SELECT
        ON ALL SEQUENCES IN SCHEMA public TO cmc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE cmc IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cmc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE cmc IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO cmc_app;
    `);
  } finally {
    await grants.end({ timeout: 2 });
  }
}
