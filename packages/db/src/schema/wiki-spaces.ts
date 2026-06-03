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
 * Wiki spaces (P3.10 / ADR-0055) — top-level containers for a tree of pages.
 * Tenant-isolated via RLS; soft-deleted. Access is tenant-wide `wiki:*` RBAC
 * for the MVP (per-space restriction is a follow-on, like folder grants P3.3b).
 */
export const wikiSpaces = pgTable(
  "wiki_spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, {
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
    tenantIdx: index("wiki_spaces_tenant_idx").on(t.tenantId),
  }),
);

export type WikiSpace = typeof wikiSpaces.$inferSelect;
export type NewWikiSpace = typeof wikiSpaces.$inferInsert;
