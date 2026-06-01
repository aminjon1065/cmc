import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * In-app notifications (P1.6 / ADR-0024).
 *
 * One row per (recipient, event). `kind` classifies the event
 * (e.g. "incident.assigned"); `link` deep-links into the app. `read_at` marks
 * it read; `dispatched_at` records when the external (email) channel fired
 * (P1.6c — null until then). Tenant-isolated via RLS; the service additionally
 * scopes every read/write to the recipient (`user_id`), so a user only ever
 * sees their own.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Event classifier, e.g. "incident.assigned" (see NOTIFICATION_KINDS). */
    kind: varchar("kind", { length: 64 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    body: text("body"),
    /** In-app deep link, e.g. "/incidents/<id>". */
    link: varchar("link", { length: 512 }),

    readAt: timestamp("read_at", { withTimezone: true }),
    /** When the email/external channel dispatched this (P1.6c). */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Unread-for-user lookups (the bell badge + list).
    userReadIdx: index("notifications_user_read_idx").on(
      t.userId,
      t.readAt,
    ),
    userCreatedIdx: index("notifications_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
    tenantIdx: index("notifications_tenant_idx").on(t.tenantId),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
