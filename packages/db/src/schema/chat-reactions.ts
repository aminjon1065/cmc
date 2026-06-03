import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { chatMessages } from "./chat-messages";

/**
 * Chat message reactions (P3.12b / ADR-0057). One row per (message, user, emoji);
 * the unique constraint makes adding the same reaction idempotent. Tenant-isolated
 * via RLS; hard-deleted (a reaction is ephemeral, no tombstone needed).
 */
export const chatReactions = pgTable(
  "chat_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    messageIdx: index("chat_reactions_message_idx").on(t.tenantId, t.messageId),
    uniq: unique("chat_reactions_uniq").on(t.messageId, t.userId, t.emoji),
  }),
);

export type ChatReaction = typeof chatReactions.$inferSelect;
export type NewChatReaction = typeof chatReactions.$inferInsert;
