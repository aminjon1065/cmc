import { z } from "zod";

/**
 * Region contracts (P4.6 / ADR-0064). A region is a logical division of users
 * and operational data within a tenant (single-site deployment — not a physical
 * DR boundary). Regional visibility is enforced server-side: a user without
 * `region:all` sees only their own region; the head office (`region:all`) sees
 * all regions. Seeded per-tenant with the administrative regions of Tajikistan,
 * then admin-editable.
 */

export const RegionSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  createdAt: z.string().datetime(),
});
export type Region = z.infer<typeof RegionSchema>;

export const RegionsListResponseSchema = z.object({
  regions: z.array(RegionSchema),
});
export type RegionsListResponse = z.infer<typeof RegionsListResponseSchema>;

export const RegionResponseSchema = z.object({ region: RegionSchema });
export type RegionResponse = z.infer<typeof RegionResponseSchema>;

/** Stable per-tenant key: UPPER_SNAKE (A–Z, 0–9, underscore), starts A–Z. */
const REGION_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export const CreateRegionSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(REGION_CODE_RE, "code must be UPPER_SNAKE (A–Z, 0–9, underscore)"),
  name: z.string().trim().min(1).max(120),
});
export type CreateRegion = z.infer<typeof CreateRegionSchema>;

export const UpdateRegionSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type UpdateRegion = z.infer<typeof UpdateRegionSchema>;

/**
 * Administrative regions of Tajikistan — seeded per-tenant on bootstrap, then
 * editable in the admin UI. `code` is stable; `name` is the display label.
 */
export const DEFAULT_TJ_REGIONS: readonly { code: string; name: string }[] = [
  { code: "DUSHANBE", name: "Душанбе" },
  { code: "SUGHD", name: "Согдийская область" },
  { code: "KHATLON", name: "Хатлонская область" },
  { code: "GBAO", name: "ГБАО" },
  { code: "RRP", name: "Районы республиканского подчинения" },
] as const;
