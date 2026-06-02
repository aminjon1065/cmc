import { z } from "zod";

/**
 * API key contracts (P3.9 / ADR-0054). A key carries a set of permission
 * strings (scopes) — a subset of what the creating admin holds — and
 * authenticates the same `/v1` endpoints as a user. The plaintext secret is
 * returned ONCE at creation; thereafter only the prefix + metadata are visible.
 */

export const ApiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Public, non-secret prefix (e.g. `cmc_a1b2c3d4`). */
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(120),
  /** RBAC permission strings (`${domain}:${action}`); must be ≤ creator's. */
  scopes: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).min(1).max(100),
  /** Optional expiry; omit for a non-expiring key. */
  expiresInDays: z.number().int().positive().max(3650).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeySchema>;

export const ApiKeyResponseSchema = z.object({ apiKey: ApiKeySchema });
export type ApiKeyResponse = z.infer<typeof ApiKeyResponseSchema>;

/** Returned only at creation — `secret` is never retrievable again. */
export const ApiKeyCreatedResponseSchema = z.object({
  apiKey: ApiKeySchema,
  secret: z.string(),
});
export type ApiKeyCreatedResponse = z.infer<typeof ApiKeyCreatedResponseSchema>;

export const ApiKeysListResponseSchema = z.object({
  apiKeys: z.array(ApiKeySchema),
});
export type ApiKeysListResponse = z.infer<typeof ApiKeysListResponseSchema>;
