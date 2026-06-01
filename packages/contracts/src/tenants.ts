import { z } from "zod";

/**
 * Tenant settings contracts (P1.4d / ADR-0022).
 *
 * A tenant_admin edits ONLY their own tenant (the id comes from the auth
 * context, never the request body), so there is no tenant id in these shapes —
 * `GET /tenant` and `PATCH /tenant` always act on the caller's tenant.
 */

export const TenantSettingsResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type TenantSettingsResponse = z.infer<
  typeof TenantSettingsResponseSchema
>;

export const UpdateTenantRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
});
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequestSchema>;
