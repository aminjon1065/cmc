import {
  type AnyPgColumn,
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";
import { wikiSpaces } from "./wiki-spaces";
import { ltree } from "./folders";

/**
 * Wiki pages (P3.10 / ADR-0055) — a nested tree per space. `content` is the
 * TipTap/ProseMirror JSON doc; `content_text` is the derived plaintext (for
 * search snippets + FTS). `path` is the ltree of id-labels (root → self) within
 * the space; descendants are `path <@ page.path` (+ same `space_id`).
 * `current_version_no` denormalises the latest snapshot (wiki_page_versions).
 * Tenant-isolated via RLS; soft-deleted.
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => wikiSpaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, {
      onDelete: "cascade",
    }),
    title: varchar("title", { length: 300 }).notNull(),
    /** TipTap/ProseMirror JSON document. */
    content: jsonb("content")
      .notNull()
      .default(sql`'{"type":"doc","content":[]}'::jsonb`),
    /** Derived plaintext of `content` — search + snippets. */
    contentText: text("content_text").notNull().default(""),
    /** ltree path of id-labels (root → self) within the space. */
    path: ltree("path").notNull(),
    currentVersionNo: integer("current_version_no").notNull().default(1),

    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("wiki_pages_tenant_idx").on(t.tenantId),
    spaceIdx: index("wiki_pages_space_idx").on(t.tenantId, t.spaceId),
    parentIdx: index("wiki_pages_parent_idx").on(t.tenantId, t.parentId),
    pathGist: index("wiki_pages_path_gist").using("gist", t.path),
    ftsIdx: index("wiki_pages_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.contentText}, ''))`,
    ),
  }),
);

export type WikiPage = typeof wikiPages.$inferSelect;
export type NewWikiPage = typeof wikiPages.$inferInsert;
