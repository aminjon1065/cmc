import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A tenant is the unit of isolation. Even in a single-tenant deployment,
 * every business row carries `tenant_id` so the platform can grow into
 * multi-tenancy without a schema rewrite (per ToR §3.2).
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    slugIdx: index("tenants_slug_idx").on(t.slug),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
