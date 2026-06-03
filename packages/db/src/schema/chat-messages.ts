import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { chatChannels } from "./chat-channels";

/**
 * Chat messages (P3.12 / ADR-0057). One row per post in a channel. `edited_at`
 * is set on edit (the UI shows "edited"); soft-deleted so a deleted message can
 * tombstone in a live stream. Tenant-isolated via RLS. Threads + reactions land
 * in P3.12b.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id, { onDelete: "cascade" }),
    /** Parent message for a threaded reply (P3.12b); null = top-level. */
    parentId: uuid("parent_id").references((): AnyPgColumn => chatMessages.id, {
      onDelete: "set null",
    }),
    authorId: uuid("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    // Feed query: latest-in-channel, with a created_at cursor for "load older".
    channelIdx: index("chat_messages_channel_idx").on(
      t.tenantId,
      t.channelId,
      t.createdAt,
    ),
  }),
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
