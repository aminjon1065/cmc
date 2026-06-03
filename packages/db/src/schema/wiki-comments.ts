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
 *
 * Anchored comments (P4.1c / ADR-0060): a top-level comment may be pinned to a
 * range of the collaborative document. `anchor` holds the encoded Yjs relative
 * positions (`{from,to}` base64, via y-prosemirror) — they auto-rebase as the
 * text is edited; `anchorText` is the quoted snapshot for display/fallback.
 * Both null for ordinary page-level comments.
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
    /** Encoded Yjs relative positions `{from,to}` (anchored comments only). */
    anchor: text("anchor"),
    /** Quoted text snapshot at anchor time (display/fallback). */
    anchorText: text("anchor_text"),
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
