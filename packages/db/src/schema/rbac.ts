import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * RBAC (P1.1 / ADR-0019).
 *
 * Model:
 *   - `permissions` is a GLOBAL catalog (no tenant_id) — the fixed set of
 *     `(domain, action)` capabilities the platform code checks against. It is
 *     the same for every tenant, like an enum; only migrations/seed write it.
 *   - `roles` are PER-TENANT (tenant_id, under RLS): each tenant owns its
 *     roles. System roles (tenant_admin / operator / auditor) are seeded per
 *     tenant and flagged `is_system` (cannot be deleted/renamed).
 *   - `role_permissions` maps a role to the catalog permissions it grants.
 *   - `user_roles` assigns a tenant's role to a tenant's user.
 */

// ---------- permissions (global catalog) ----------
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "document", "incident", "role". */
    domain: varchar("domain", { length: 64 }).notNull(),
    /** e.g. "read", "write", "delete", "assign". */
    action: varchar("action", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    domainActionUq: uniqueIndex("permissions_domain_action_uq").on(
      t.domain,
      t.action,
    ),
  }),
);

// ---------- roles (per-tenant) ----------
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable machine slug, unique per tenant (e.g. "tenant_admin"). */
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    description: varchar("description", { length: 255 }),
    /** System roles are seeded + immutable (no delete / no slug change). */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantSlugUq: uniqueIndex("roles_tenant_slug_uq").on(t.tenantId, t.slug),
    tenantIdx: index("roles_tenant_idx").on(t.tenantId),
  }),
);

// ---------- role_permissions ----------
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
    permIdx: index("role_permissions_permission_idx").on(t.permissionId),
  }),
);

// ---------- user_roles (per-tenant assignment) ----------
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** Denormalised for RLS scoping (same value as the role's + user's tenant). */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roleId] }),
    userIdx: index("user_roles_user_idx").on(t.userId),
    roleIdx: index("user_roles_role_idx").on(t.roleId),
    tenantIdx: index("user_roles_tenant_idx").on(t.tenantId),
  }),
);

export type Permission = typeof permissions.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type UserRole = typeof userRoles.$inferSelect;
