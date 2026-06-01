import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Per-user notification preferences (P1.6c / ADR-0024).
 *
 * One row per (user, kind) toggling the in-app and email channels. A MISSING
 * row means "both on" (the service fills defaults), so a fresh user gets
 * everything until they opt out. `tenant_id` is denormalised for RLS.
 */
export const userNotificationPrefs = pgTable(
  "user_notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Notification kind (e.g. "incident.assigned"). */
    kind: varchar("kind", { length: 64 }).notNull(),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.kind] }),
    tenantIdx: index("user_notification_prefs_tenant_idx").on(t.tenantId),
  }),
);

export type UserNotificationPref = typeof userNotificationPrefs.$inferSelect;
export type NewUserNotificationPref =
  typeof userNotificationPrefs.$inferInsert;
