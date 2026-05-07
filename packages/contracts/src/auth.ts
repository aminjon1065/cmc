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

export const LoginResponseSchema = z.object({
  user: AuthUserSchema,
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ---------- /auth/me ----------

export const MeResponseSchema = z.object({
  user: AuthUserSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------- JWT claims (internal but typed) ----------

export const JwtClaimsSchema = z.object({
  sub: z.string().uuid(), // user id
  tid: z.string().uuid(), // tenant id
  ts: z.string(), // tenant slug (for human-friendly logs)
  email: z.string().email(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
