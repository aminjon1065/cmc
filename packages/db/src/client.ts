import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Create a Drizzle client. The caller owns the lifecycle of the underlying
 * postgres connection pool and is responsible for closing it on shutdown.
 *
 * In NestJS this is wired through a provider so the same instance is reused
 * across the request lifecycle.
 */
export function createDatabase(connectionString: string, opts?: {
  max?: number;
  idleTimeout?: number;
}) {
  const client = postgres(connectionString, {
    max: opts?.max ?? 20,
    idle_timeout: opts?.idleTimeout ?? 30,
    prepare: false,
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return {
    db,
    client,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}
