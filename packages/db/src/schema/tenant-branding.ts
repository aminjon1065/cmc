import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Per-tenant branding (P0.11 / ADR-0018).
 *
 * One row per tenant (tenant_id is BOTH the PK and the FK), so a tenant has
 * at most one branding record. Keeps the org identity — names, country,
 * location, mural copy, logo, theme — out of the frontend code so a second
 * tenant can be onboarded by inserting a row, not editing components.
 *
 * `copy` holds the text blocks (orgName, muralHeadline, …) as a jsonb bag so
 * new strings can be added without a migration. `theme` is reserved for the
 * future token/colour overrides that pair with the design-system work
 * (TD-023); empty `{}` today.
 */
export const tenantBranding = pgTable("tenant_branding", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** Default locale for this tenant's UI (e.g. "en", "ru", "tg"). */
  localeDefault: varchar("locale_default", { length: 12 })
    .notNull()
    .default("en"),
  /** Optional logo/emblem URL; null → the built-in emblem. */
  logoUrl: varchar("logo_url", { length: 1024 }),
  /** Text blocks — see @cmc/contracts BrandingCopy for the known keys. */
  copy: jsonb("copy").notNull().default({}),
  /** Reserved for per-tenant theme tokens (TD-023); empty today. */
  theme: jsonb("theme").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantBrandingRow = typeof tenantBranding.$inferSelect;
export type NewTenantBrandingRow = typeof tenantBranding.$inferInsert;
