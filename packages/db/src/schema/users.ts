import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { regions } from "./regions";

/**
 * Users are scoped to a tenant. Email uniqueness is per-tenant: the same
 * email can exist in two different tenants without conflict.
 *
 * `password_hash` is nullable to allow SSO-only accounts (provisioned via
 * OIDC/SAML) that never set a local password.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Region this user belongs to (P4.6). NULL = unassigned / head-office pool.
     * Regional visibility is enforced in the service layer (a user without
     * `region:all` sees only rows matching their `region_id`).
     */
    regionId: uuid("region_id").references(() => regions.id, {
      onDelete: "set null",
    }),
    /**
     * Persisted UI preferences (ADR-0078) so the choice follows the user across
     * browsers/devices. NULL = no explicit choice (web falls back to light + RU).
     * `ui_theme` ∈ light|dark|system; `ui_locale` ∈ ru|tg. The web seeds its
     * cookies from these on login and PATCHes them on toggle.
     */
    uiTheme: varchar("ui_theme", { length: 8 }),
    uiLocale: varchar("ui_locale", { length: 8 }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantEmailUq: uniqueIndex("users_tenant_email_uq").on(t.tenantId, t.email),
    tenantIdx: index("users_tenant_idx").on(t.tenantId),
    regionIdx: index("users_region_idx").on(t.tenantId, t.regionId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
