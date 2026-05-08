/**
 * Jest global setup — runs once before any worker starts.
 *
 * Idempotently bootstraps the test database:
 *   1. Connect to the `postgres` admin DB and CREATE DATABASE cmc_test
 *      if it doesn't exist.
 *   2. Connect to cmc_test as the owner, ensure the `cmc_app` runtime
 *      role exists with NOSUPERUSER NOBYPASSRLS, and grant CONNECT +
 *      schema USAGE.
 *   3. Apply every Drizzle migration (incl. RLS policies) to cmc_test.
 *   4. After migrations have created the tables, grant SELECT/INSERT/
 *      UPDATE/DELETE on them to cmc_app, plus default privileges so
 *      future tables auto-grant.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

loadDotenv({ path: resolve(__dirname, "..", ".env.test") });
loadDotenv({ path: resolve(__dirname, "..", ".env") });

const OWNER_URL =
  process.env.DATABASE_OWNER_URL ??
  "postgresql://cmc:cmc_dev_password_change_me@localhost:5432/cmc_test";

function adminUrl(): string {
  // Same host/credentials as OWNER_URL but pointed at the `postgres`
  // database so we can issue CREATE DATABASE.
  return OWNER_URL.replace(/\/[^/]+$/, "/postgres");
}

function dbName(): string {
  return new URL(OWNER_URL).pathname.slice(1);
}

export default async function globalSetup(): Promise<void> {
  // 1. Create the test database if missing.
  const admin = postgres(adminUrl(), { max: 1, prepare: false });
  try {
    const exists = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${dbName()}
    `;
    if (exists.length === 0) {
      // CREATE DATABASE can't run in a transaction.
      await admin.unsafe(`CREATE DATABASE ${dbName()}`);
      // eslint-disable-next-line no-console
      console.log(`[test setup] created database ${dbName()}`);
    }
  } finally {
    await admin.end({ timeout: 2 });
  }

  // 2. Ensure cmc_app role + database-level grants.
  const owner = postgres(OWNER_URL, { max: 1, prepare: false });
  try {
    await owner.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmc_app') THEN
          CREATE ROLE cmc_app
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            INHERIT
            NOREPLICATION
            NOBYPASSRLS
            PASSWORD 'cmc_app_dev_password_change_me';
        END IF;
      END $$;
    `);
    await owner.unsafe(`GRANT CONNECT ON DATABASE ${dbName()} TO cmc_app`);
    await owner.unsafe(`GRANT USAGE ON SCHEMA public TO cmc_app`);
  } finally {
    await owner.end({ timeout: 2 });
  }

  // 3. Apply migrations.
  const migrator = postgres(OWNER_URL, { max: 1, prepare: false });
  try {
    await migrate(drizzle(migrator), {
      migrationsFolder: resolve(__dirname, "../../../packages/db/migrations"),
    });
  } finally {
    await migrator.end({ timeout: 2 });
  }

  // 4. Now that tables exist, grant CRUD on them and on sequences,
  //    and set default privileges so future migrations auto-grant.
  const grants = postgres(OWNER_URL, { max: 1, prepare: false });
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
