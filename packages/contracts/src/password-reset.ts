import { z } from "zod";

/**
 * Password-reset contracts (P1.3 / ADR-0021).
 *
 * Two entry points share one single-use, hashed token in `password_resets`:
 *   - Self-initiated:  POST /auth/password/forgot { email }      → always 204
 *                      (the token is delivered out-of-band via the notifier;
 *                       dev logs it, P1.6 swaps in email). No enumeration.
 *   - Admin-initiated: POST /auth/password/admin-reset/:userId   → returns the
 *                      token to the calling admin (gated by `user:manage`).
 *
 * Both finish at:
 *   - POST /auth/password/reset { token, newPassword }           → 204
 *
 * A reset changes ONLY the password: it revokes the user's sessions (forcing a
 * fresh login) but leaves any MFA factor intact, so the next login still
 * requires the second factor.
 */

// Reuse the same password rule as login so there's a single policy.
const NewPasswordSchema = z.string().min(8).max(256);

// ---------- self-initiated ----------

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email().max(320),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

// ---------- completion (shared) ----------

export const ResetPasswordRequestSchema = z.object({
  /** The opaque token delivered to the user / handed to the admin. */
  token: z.string().min(16).max(128),
  newPassword: NewPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

// ---------- admin-initiated ----------

/**
 * Body of POST /auth/password/admin-reset/:userId. Empty today; defined so the
 * route has a typed contract and can grow (e.g. an optional `notify` flag once
 * the email channel lands in P1.6).
 */
export const AdminResetRequestSchema = z.object({}).strict();
export type AdminResetRequest = z.infer<typeof AdminResetRequestSchema>;

/**
 * Returned to the admin who initiated the reset. The token is shown ONCE — the
 * admin relays it to the user out-of-band. `expiresAt` lets the UI show a
 * countdown.
 */
export const AdminResetResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
});
export type AdminResetResponse = z.infer<typeof AdminResetResponseSchema>;
