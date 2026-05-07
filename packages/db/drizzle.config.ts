import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Load env from apps/api/.env (single source of truth for DATABASE_URL during
// migration generation/execution). Override with the environment if already set.
loadEnv({ path: resolve(__dirname, "../../apps/api/.env") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env or export DATABASE_URL.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
