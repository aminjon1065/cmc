import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * API keys for programmatic access (P3.9 / ADR-0054). A key authenticates the
 * same `/v1` endpoints as a logged-in user; its `scopes` (a subset of RBAC
 * permission strings) gate it via the existing `@Authorize` guard. Only the
 * SHA-256 `key_hash` is stored — the secret is shown once at creation and never
 * persisted (same posture as session/reset tokens). `key_prefix` is the public,
 * non-secret identifier shown in lists. Tenant-isolated via RLS.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 120 }).notNull(),
    /** Public prefix (e.g. `cmc_a1b2c3d4`) — safe to display. */
    keyPrefix: varchar("key_prefix", { length: 24 }).notNull(),
    /** SHA-256 hex of the full secret. Unique → O(1) auth lookup. */
    keyHash: varchar("key_hash", { length: 128 }).notNull(),
    /** Granted permission strings (subset of the creator's). */
    scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),

    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId),
    hashIdx: uniqueIndex("api_keys_hash_idx").on(t.keyHash),
  }),
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
