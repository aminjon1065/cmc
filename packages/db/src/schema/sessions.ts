import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  inet,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Session = one chain of access/refresh token issuances tied to a single
 * login event. Each refresh rotation produces a new row in the same
 * `family_id` group. A replayed (already-superseded) refresh token is a
 * theft signal and revokes the entire family.
 *
 *   login            → row A (family A, parent=null)
 *   refresh A        → row B (family A, parent=A) + A.revoked_at = now
 *   refresh B        → row C (family A, parent=B) + B.revoked_at = now
 *   refresh A again  → REPLAY: revoke entire family (A, B, C)
 *
 * The `id` column is also embedded as the `sid` claim in the access JWT,
 * so middleware can verify the session is still active without trusting
 * the bearer alone.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // All sessions issued from the same login share a family_id. Replay of
    // any superseded refresh token revokes the whole family.
    familyId: uuid("family_id").notNull(),

    // Refresh token is stored as sha256 of the secret. The plain token only
    // ever appears in the response to the client. Lookup by hash is exact.
    refreshTokenHash: varchar("refresh_token_hash", { length: 128 })
      .notNull()
      .unique(),

    // Pointer to the previous session row in the family chain. Null on the
    // very first row (login). Used to walk the chain during replay
    // detection / forensics.
    parentId: uuid("parent_id"),

    ip: inet("ip"),
    userAgent: varchar("user_agent", { length: 512 }),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Set when the session is no longer usable. Once non-null the session
    // cannot be refreshed and any access token bearing this `sid` is
    // rejected by the middleware.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // 'logout' | 'rotation_replay' | 'rotation_superseded' | 'admin' | 'expired'
    revokedReason: varchar("revoked_reason", { length: 32 }),
  },
  (t) => ({
    tenantIdx: index("sessions_tenant_idx").on(t.tenantId),
    userIdx: index("sessions_user_idx").on(t.userId),
    familyIdx: index("sessions_family_idx").on(t.familyId),
    activeUserIdx: index("sessions_active_user_idx").on(
      t.userId,
      t.revokedAt,
    ),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
