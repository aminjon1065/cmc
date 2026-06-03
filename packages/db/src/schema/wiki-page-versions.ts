import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { wikiPages } from "./wiki-pages";

/**
 * Immutable wiki page version snapshots (P3.10 / ADR-0055). One row per save —
 * full title + content captured, so restore is a repoint (mirrors
 * document_versions, P3.4). Tenant-isolated via RLS.
 */
export const wikiPageVersions = pgTable(
  "wiki_page_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    content: jsonb("content").notNull(),
    contentText: text("content_text").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pageIdx: index("wiki_page_versions_page_idx").on(t.tenantId, t.pageId),
    uniqueVersion: uniqueIndex("wiki_page_versions_unique").on(
      t.pageId,
      t.versionNo,
    ),
  }),
);

export type WikiPageVersion = typeof wikiPageVersions.$inferSelect;
export type NewWikiPageVersion = typeof wikiPageVersions.$inferInsert;
