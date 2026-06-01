import { z } from "zod";

/**
 * Tenant branding contract (P0.11 / ADR-0018).
 *
 * The org identity — names, country, location, mural copy, footer — that used
 * to be hardcoded in the web components. The API serves it per-tenant (or the
 * platform default for anonymous / pre-auth pages) so a second tenant is
 * onboarded by inserting a row, not editing code.
 *
 * IMPORTANT: this file carries the GENERIC platform default only. The
 * Tajikistan-CMC values live exclusively in the seed (which writes them to the
 * default tenant's `tenant_branding` row). Nothing tenant-specific belongs
 * here.
 */

/** The known text blocks. All optional at the row level; the resolver fills
 * gaps from {@link DEFAULT_BRANDING_COPY}. */
export type BrandingCopy = {
  /** Full organisation name, e.g. shown in the sidebar header + metadata. */
  orgName: string;
  /** Short qualifier under the org name, e.g. a division + country code. */
  orgShort: string;
  /** Country / jurisdiction the deployment serves. */
  country: string;
  /** Label for the operational-status location (dashboard hero). */
  statusLocation: string;
  /** Data-center / hosting location line (login mural footer). */
  dataCenter: string;
  /** Small kicker above the mural headline (login). */
  muralKicker: string;
  /** Mural headline (login left panel). */
  muralHeadline: string;
  /** Mural sub-copy paragraph (login). */
  muralSubcopy: string;
  /** Build/version label (login mural footer). */
  buildLabel: string;
  /** Compliance line (login mural footer). */
  complianceLine: string;
  /** Document <title> default. */
  metaTitle: string;
  /** Document meta description. */
  metaDescription: string;
};

/** The full branding payload returned by `GET /branding`. */
export type TenantBranding = {
  /** Tenant slug this branding belongs to, or "default" for the platform fallback. */
  tenantSlug: string;
  localeDefault: string;
  logoUrl: string | null;
  copy: BrandingCopy;
  /** Reserved for per-tenant theme tokens (TD-023); empty today. */
  theme: Record<string, string>;
};

/**
 * Generic, vendor-neutral copy. Used when a tenant has no branding row, and as
 * the gap-filler for partially-populated rows. Deliberately contains NO
 * Tajikistan / CMC specifics — those are seed-only data.
 */
export const DEFAULT_BRANDING_COPY: BrandingCopy = {
  orgName: "Operational Intelligence Platform",
  orgShort: "Enterprise Operations",
  country: "",
  statusLocation: "Operational Status",
  dataCenter: "Primary Data Center",
  muralKicker: "Unified enterprise operational intelligence",
  muralHeadline: "Operational intelligence,\noperated at enterprise scale.",
  muralSubcopy:
    "Geospatial · Realtime · Workflow · Audit · AI — converged into a single command surface for enterprise operations.",
  buildLabel: "",
  complianceLine: "ISO 27001 · SOC 2 Type II",
  metaTitle: "Operational Intelligence Platform",
  metaDescription: "Unified enterprise operational intelligence platform.",
};

/** The platform-default branding payload (anonymous / no-row fallback). */
export const DEFAULT_BRANDING: TenantBranding = {
  tenantSlug: "default",
  localeDefault: "en",
  logoUrl: null,
  copy: DEFAULT_BRANDING_COPY,
  theme: {},
};

// ---------- branding update (P1.4d / ADR-0022) ----------

/** The known copy keys, all editable. Used to validate `PUT /branding`. */
export const BrandingCopySchema = z.object({
  orgName: z.string().max(255),
  orgShort: z.string().max(255),
  country: z.string().max(255),
  statusLocation: z.string().max(255),
  dataCenter: z.string().max(255),
  muralKicker: z.string().max(500),
  muralHeadline: z.string().max(500),
  muralSubcopy: z.string().max(1000),
  buildLabel: z.string().max(255),
  complianceLine: z.string().max(255),
  metaTitle: z.string().max(255),
  metaDescription: z.string().max(500),
}) satisfies z.ZodType<BrandingCopy>;

/**
 * Body of `PUT /branding`. All fields optional (partial update); `copy` is a
 * partial bag so a form can send just the keys it edits. `theme` is reserved
 * (TD-023) and intentionally not editable here yet.
 */
export const UpdateBrandingRequestSchema = z
  .object({
    localeDefault: z.string().min(2).max(12).optional(),
    logoUrl: z.string().url().max(1024).nullable().optional(),
    copy: BrandingCopySchema.partial().optional(),
  })
  .refine(
    (v) =>
      v.localeDefault !== undefined ||
      v.logoUrl !== undefined ||
      v.copy !== undefined,
    { message: "Provide at least one of localeDefault, logoUrl, or copy" },
  );
export type UpdateBrandingRequest = z.infer<typeof UpdateBrandingRequestSchema>;
