import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Password reset tokens (P1.3 / ADR-0021).
 *
 * The token is single-use and stored HASHED (sha256) — only the hash lives
 * in the DB, exactly like refresh tokens (ADR-0003), so a DB dump cannot
 * be used to reset passwords. A row is valid while `used_at IS NULL` and
 * `expires_at > now()`. `created_by` distinguishes admin-initiated resets
 * (the admin's user id) from self-initiated ones (null).
 *
 * Tenant-isolated via RLS (denormalised `tenant_id`).
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** sha256(hex) of the random token. The plaintext is never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** The admin who initiated an admin-reset; null for self-initiated. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenHashIdx: index("password_resets_token_hash_idx").on(t.tokenHash),
    userIdx: index("password_resets_user_idx").on(t.userId),
    tenantIdx: index("password_resets_tenant_idx").on(t.tenantId),
  }),
);

export type PasswordReset = typeof passwordResets.$inferSelect;
export type NewPasswordReset = typeof passwordResets.$inferInsert;
