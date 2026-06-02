import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Postgres `ltree` materialised-path type (P3.3 / ADR-0047). Labels are folder
 * ids with hyphens stripped (UUIDs aren't ltree-label-safe), joined by `.`.
 * Because labels are ids — not names — a rename never repaths; only a move does.
 */
export const ltree = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});

/**
 * Document folders — a per-tenant tree. `path` is the ltree from the root to
 * this folder (inclusive); descendants are `path <@ folder.path`. `parent_id`
 * is kept alongside for cheap immediate-children queries + FK cascade. RLS
 * isolates per tenant; soft-deleted via `deleted_at`. Per-folder permission
 * inheritance (ACLs) is the P3.3b follow-on.
 */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    /** ltree path of id-labels (root → self). GiST-indexed for subtree queries. */
    path: ltree("path").notNull(),
    /**
     * When true, this folder + its descendants are accessible only to subjects
     * with an inherited `folder_grants` grant (P3.3b / ADR-0048) — plus
     * `folder:manage` holders and the folder's creator. Unrestricted folders
     * fall back to tenant-wide RBAC.
     */
    restricted: boolean("restricted").notNull().default(false),
    /**
     * Retention policy (P3.5 / ADR-0050): soft-delete documents this many days
     * after their last update. Inherited down the subtree (the nearest ancestor
     * folder with a non-null value wins); null = no policy.
     */
    retentionDays: integer("retention_days"),
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
    tenantIdx: index("folders_tenant_idx").on(t.tenantId),
    parentIdx: index("folders_parent_idx").on(t.tenantId, t.parentId),
    // GiST on the ltree path → fast `<@` / `@>` subtree + ancestor queries.
    pathGist: index("folders_path_gist").using("gist", t.path),
  }),
);

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
