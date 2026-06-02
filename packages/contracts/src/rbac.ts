import { z } from "zod";

/**
 * RBAC contracts (P1.1 / ADR-0019).
 *
 * The permission catalog + system-role definitions are the single source of
 * truth for both the seed (which writes them to the DB) and the platform code
 * (the `@Authorize('document:read')` strings). Keeping them here means the
 * guard's permission strings and the seeded rows can never drift.
 */

/** A capability, as `${domain}:${action}`. */
export type Permission = `${string}:${string}`;

/** One catalog entry. */
export type PermissionDef = {
  domain: string;
  action: string;
  description: string;
};

/**
 * The global permission catalog. Add a row here, run the seed, and the
 * capability exists platform-wide. The guard references these by their
 * `${domain}:${action}` string.
 */
export const PERMISSION_CATALOG = [
  // Documents (the first protected module).
  { domain: "document", action: "read", description: "View documents" },
  {
    domain: "document",
    action: "write",
    description: "Create / upload / finalize documents",
  },
  { domain: "document", action: "delete", description: "Delete documents" },
  // Sessions / account.
  {
    domain: "session",
    action: "read",
    description: "List one's own sessions",
  },
  // Audit.
  { domain: "audit", action: "read", description: "Read the audit log" },
  // User administration.
  {
    domain: "user",
    action: "manage",
    description: "Manage users: initiate password resets, (de)activate",
  },
  // RBAC administration.
  {
    domain: "role",
    action: "read",
    description: "View roles and their permissions",
  },
  {
    domain: "role",
    action: "assign",
    description: "Assign / remove roles to users",
  },
  {
    domain: "role",
    action: "manage",
    description: "Create, edit, and delete custom roles",
  },
  // Tenant administration.
  {
    domain: "tenant",
    action: "manage",
    description: "Edit tenant settings (name, branding)",
  },
  // Incidents (P1.5).
  { domain: "incident", action: "read", description: "View incidents" },
  { domain: "incident", action: "create", description: "Report new incidents" },
  {
    domain: "incident",
    action: "write",
    description: "Edit incidents and advance status (triage, start, reopen)",
  },
  {
    domain: "incident",
    action: "assign",
    description: "Assign incidents to responders",
  },
  {
    domain: "incident",
    action: "resolve",
    description: "Resolve / close incidents",
  },
  { domain: "incident", action: "delete", description: "Delete incidents" },
  // Cases (P2.10).
  { domain: "case", action: "read", description: "View cases + activity" },
  { domain: "case", action: "create", description: "Open new cases" },
  {
    domain: "case",
    action: "write",
    description: "Edit cases, comment, and advance status",
  },
  { domain: "case", action: "assign", description: "Assign cases to users" },
  { domain: "case", action: "resolve", description: "Resolve / close cases" },
  { domain: "case", action: "delete", description: "Delete cases" },
  // GIS / spatial (P2.7). NB: permission keys are `${domain}:${action}` split on
  // a single colon, so the sub-resource lives in the domain (gis_layer/gis_feature).
  {
    domain: "gis_layer",
    action: "read",
    description: "View GIS layers + features",
  },
  {
    domain: "gis_layer",
    action: "edit",
    description: "Create, edit, and delete GIS layers",
  },
  {
    domain: "gis_feature",
    action: "write",
    description: "Create, edit, and delete GIS features",
  },
] as const satisfies readonly PermissionDef[];

/** Helper: the `${domain}:${action}` string for a catalog entry. */
export function permKey(def: PermissionDef): Permission {
  return `${def.domain}:${def.action}`;
}

/** Every permission string in the catalog. */
export const ALL_PERMISSIONS: readonly Permission[] =
  PERMISSION_CATALOG.map(permKey);

/**
 * System roles seeded per-tenant. `permissions: "*"` means "every catalog
 * permission" (resolved at seed time). System roles are immutable.
 */
export type SystemRoleDef = {
  slug: string;
  name: string;
  description: string;
  permissions: readonly Permission[] | "*";
};

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    slug: "tenant_admin",
    name: "Tenant Administrator",
    description: "Full control within the tenant.",
    permissions: "*",
  },
  {
    slug: "operator",
    name: "Operator",
    description: "Day-to-day operations: documents + incident response.",
    permissions: [
      "document:read",
      "document:write",
      "session:read",
      "incident:read",
      "incident:create",
      "incident:write",
      "incident:assign",
      "incident:resolve",
      "case:read",
      "case:create",
      "case:write",
      "case:assign",
      "case:resolve",
      "gis_layer:read",
      "gis_feature:write",
    ],
  },
  {
    slug: "auditor",
    name: "Auditor",
    description: "Read-only access plus the audit log.",
    permissions: [
      "document:read",
      "session:read",
      "audit:read",
      "role:read",
      "incident:read",
      "case:read",
      "gis_layer:read",
    ],
  },
] as const;

// ---------- API response shapes ----------

export type RoleResponse = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Permission[];
};

export type RolesListResponse = {
  roles: RoleResponse[];
};

export type UserRolesResponse = {
  userId: string;
  roles: RoleResponse[];
};

// ---------- "my access" (P1.4 / ADR-0022) ----------

/**
 * The current user's effective access, returned by `GET /rbac/me`. The web
 * app calls this to gate the `/admin/*` section and decide which nav to show
 * (permissions are resolved server-side, not carried in the auth token).
 * Validated with zod on the web (unlike the P1.1 plain-type responses) because
 * it crosses the BFF boundary into client-driven gating.
 */
export const MyRoleSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});

export const MyAccessResponseSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  roles: z.array(MyRoleSchema),
  permissions: z.array(z.string()),
});
export type MyAccessResponse = z.infer<typeof MyAccessResponseSchema>;

/**
 * Zod mirror of `RolesListResponse` (the plain type above) so the web can
 * validate `GET /rbac/roles` when rendering the admin role pickers (P1.4b).
 */
export const RolesListResponseSchema = z.object({
  roles: z.array(MyRoleSchema),
});

// ---------- custom-role management (P1.4c / ADR-0022) ----------

/** One row of the global permission catalog, for the role editor. */
export const PermissionCatalogEntrySchema = z.object({
  domain: z.string(),
  action: z.string(),
  key: z.string(),
  description: z.string(),
});
export type PermissionCatalogEntry = z.infer<
  typeof PermissionCatalogEntrySchema
>;

export const PermissionCatalogResponseSchema = z.object({
  permissions: z.array(PermissionCatalogEntrySchema),
});
export type PermissionCatalogResponse = z.infer<
  typeof PermissionCatalogResponseSchema
>;

/** Single-role envelope returned by create / detail. */
export const RoleDetailResponseSchema = z.object({ role: MyRoleSchema });
export type RoleDetailResponse = z.infer<typeof RoleDetailResponseSchema>;

const ROLE_SLUG_RE = /^[a-z][a-z0-9_]*$/;

export const CreateRoleRequestSchema = z.object({
  slug: z
    .string()
    .max(64)
    .regex(
      ROLE_SLUG_RE,
      "slug must be lowercase letters/digits/underscore, starting with a letter",
    ),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(255).optional(),
  permissions: z.array(z.string()).max(100).default([]),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

export const UpdateRoleRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(255).nullable().optional(),
    permissions: z.array(z.string()).max(100).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.permissions !== undefined,
    { message: "Provide at least one of name, description, or permissions" },
  );
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;
