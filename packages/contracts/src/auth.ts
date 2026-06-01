import { z } from "zod";

/**
 * Auth-related contracts shared between web BFF and the NestJS API.
 *
 * The same schemas validate the request on the server and the response on the
 * client, so a contract drift surfaces as a type or runtime validation error
 * rather than as a silent shape mismatch.
 */

// ---------- Login ----------

export const LoginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/**
 * Token bundle issued by /auth/login and /auth/refresh.
 * - `accessToken` is short-lived (≈15 min) and goes on every API call.
 * - `refreshToken` is long-lived (≈30 days), single-use, rotated on /auth/refresh.
 */
export const TokenBundleSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string().datetime(),
});
export type TokenBundle = z.infer<typeof TokenBundleSchema>;

export const LoginResponseSchema = TokenBundleSchema.extend({
  user: AuthUserSchema,
  // Discriminator for the MFA two-step flow (P1.2). Optional + defaulted so
  // existing consumers that don't look at it keep working; a parsed response
  // always carries `status: "ok"` on the success path.
  status: z.literal("ok").default("ok"),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ---------- Refresh ----------

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = TokenBundleSchema;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

// ---------- /auth/me ----------

export const MeResponseSchema = z.object({
  user: AuthUserSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------- Sessions ----------

export const SessionSummarySchema = z.object({
  id: z.string().uuid(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type SessionsListResponse = z.infer<typeof SessionsListResponseSchema>;

// ---------- JWT claims (internal but typed) ----------

export const JwtClaimsSchema = z.object({
  sub: z.string().uuid(), // user id
  tid: z.string().uuid(), // tenant id
  ts: z.string(), // tenant slug (for human-friendly logs)
  sid: z.string().uuid(), // session id
  email: z.string().email(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
