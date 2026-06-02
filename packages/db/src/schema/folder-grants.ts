import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { folders } from "./folders";
import { users } from "./users";

/**
 * Per-folder access grants (P3.3b / ADR-0048). A grant on a folder inherits down
 * its whole subtree (checked via the folders ltree path: a folder F is unlocked
 * for a subject with a grant on any ancestor-or-self of F). The subject is
 * polymorphic — a `user` or a `role` (no FK on `subject_id`, hence the type tag).
 * `access` is `read` or `write`. Tenant-isolated via RLS.
 */
export const folderGrants = pgTable(
  "folder_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    /** 'user' | 'role' */
    subjectType: varchar("subject_type", { length: 10 }).notNull(),
    /** user id or role id (polymorphic — no FK). */
    subjectId: uuid("subject_id").notNull(),
    /** 'read' | 'write' */
    access: varchar("access", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One grant per (folder, subject) — the access level is updated in place.
    uniqueSubject: uniqueIndex("folder_grants_subject_uniq").on(
      t.folderId,
      t.subjectType,
      t.subjectId,
    ),
    folderIdx: index("folder_grants_folder_idx").on(t.tenantId, t.folderId),
    subjectIdx: index("folder_grants_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
  }),
);

export type FolderGrant = typeof folderGrants.$inferSelect;
export type NewFolderGrant = typeof folderGrants.$inferInsert;
