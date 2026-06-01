import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Multi-factor authentication (P1.2 / ADR-0020).
 *
 *  - `user_mfa_methods` holds the enrolled factor (TOTP today). The secret is
 *    stored ENCRYPTED at rest (AES-256-GCM, app-level — see ADR-0020), never
 *    in plaintext. A method is only enforced once `verified_at` is set (the
 *    user proved possession with a first valid code).
 *  - `mfa_backup_codes` are one-time recovery codes, stored as argon2 hashes
 *    (like passwords). `used_at` marks a code as consumed.
 *
 * Both are tenant-isolated via RLS (denormalised `tenant_id`).
 */

export const userMfaMethods = pgTable(
  "user_mfa_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Factor kind. Only "totp" today; "webauthn" is a future addition. */
    kind: varchar("kind", { length: 16 }).notNull().default("totp"),
    /** AES-256-GCM ciphertext of the base32 TOTP secret (see common/crypto). */
    secretEncrypted: text("secret_encrypted").notNull(),
    /** Set when the user confirms enrolment with a first valid code. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One TOTP method per user (re-enrolling replaces it).
    userKindUq: uniqueIndex("user_mfa_methods_user_kind_uq").on(
      t.userId,
      t.kind,
    ),
    tenantIdx: index("user_mfa_methods_tenant_idx").on(t.tenantId),
  }),
);

export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** argon2id hash of the plaintext backup code. */
    codeHash: varchar("code_hash", { length: 255 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("mfa_backup_codes_user_idx").on(t.userId),
    tenantIdx: index("mfa_backup_codes_tenant_idx").on(t.tenantId),
  }),
);

export type UserMfaMethod = typeof userMfaMethods.$inferSelect;
export type NewUserMfaMethod = typeof userMfaMethods.$inferInsert;
export type MfaBackupCode = typeof mfaBackupCodes.$inferSelect;
