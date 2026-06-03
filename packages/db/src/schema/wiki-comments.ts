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
import { wikiPages } from "./wiki-pages";

/**
 * Wiki page comments (P3.10b / ADR-0055). Threaded via `parent_id` (a reply
 * points at its parent comment). Tenant-isolated via RLS; soft-deleted so a
 * deleted parent can keep its thread context.
 */
export const wikiComments = pgTable(
  "wiki_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => wikiComments.id,
      { onDelete: "cascade" },
    ),
    authorId: uuid("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    pageIdx: index("wiki_comments_page_idx").on(t.tenantId, t.pageId),
  }),
);

export type WikiComment = typeof wikiComments.$inferSelect;
export type NewWikiComment = typeof wikiComments.$inferInsert;
