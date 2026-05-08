/**
 * Programmatic migrator. Run with `pnpm --filter @cmc/db migrate`.
 *
 * Reads DATABASE_URL from apps/api/.env (or the inherited environment),
 * applies any pending SQL migrations from ./migrations, and exits.
 */
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(__dirname, "../../../apps/api/.env") });

async function main() {
  // Migrations DDL — use the privileged owner connection. Falls back to
  // DATABASE_URL for setups where a single role does both.
  const url = process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_OWNER_URL (or DATABASE_URL) is required to run migrations.",
    );
  }

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  // eslint-disable-next-line no-console
  console.log("Applying migrations...");
  await migrate(db, {
    migrationsFolder: resolve(__dirname, "../migrations"),
  });
  // eslint-disable-next-line no-console
  console.log("Migrations applied.");

  await sql.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
