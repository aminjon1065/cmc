import { z } from "zod";

/**
 * MFA / TOTP contracts (P1.2 / ADR-0020).
 *
 * Login is now a two-step flow when the user has a verified TOTP factor:
 *   1. POST /auth/login  → `{ status: "mfa_required", mfaToken }`
 *   2. POST /auth/mfa/verify { mfaToken, code }  → the usual token bundle
 *
 * Users WITHOUT MFA still get the token bundle directly from /auth/login
 * (now tagged `status: "ok"`).
 */

// ---------- enrolment ----------

/** Returned by POST /auth/mfa/enrol — everything needed to add the factor. */
export const MfaEnrolResponseSchema = z.object({
  /** Base32 secret for manual entry. */
  secret: z.string(),
  /** otpauth:// URI encoded in the QR. */
  otpauthUri: z.string(),
  /** Data-URL PNG of the QR code (render directly in an <img>). */
  qrDataUrl: z.string(),
});
export type MfaEnrolResponse = z.infer<typeof MfaEnrolResponseSchema>;

/** POST /auth/mfa/confirm — prove possession with the first code. */
export const MfaConfirmRequestSchema = z.object({
  code: z.string().min(6).max(14),
});
export type MfaConfirmRequest = z.infer<typeof MfaConfirmRequestSchema>;

/** Returned by confirm + regenerate — the one-time backup codes (shown ONCE). */
export const MfaBackupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()),
});
export type MfaBackupCodesResponse = z.infer<
  typeof MfaBackupCodesResponseSchema
>;

// ---------- status / disable ----------

export const MfaStatusResponseSchema = z.object({
  /** True once a verified TOTP factor exists. */
  enabled: z.boolean(),
  /** Whether an unconfirmed enrolment is pending. */
  pending: z.boolean(),
  /** Count of unused backup codes (0 when MFA off). */
  backupCodesRemaining: z.number().int().nonnegative(),
});
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

export const MfaDisableRequestSchema = z.object({
  /** A current TOTP code OR a backup code, to authorise disabling. */
  code: z.string().min(6).max(14),
});
export type MfaDisableRequest = z.infer<typeof MfaDisableRequestSchema>;

// ---------- login second step ----------

/** POST /auth/mfa/verify — complete login with the second factor. */
export const MfaVerifyRequestSchema = z.object({
  mfaToken: z.string().min(10),
  /** A 6-digit TOTP code or a backup code. */
  code: z.string().min(6).max(14),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** The body /auth/login returns when MFA is required (no session yet). */
export const MfaRequiredResponseSchema = z.object({
  status: z.literal("mfa_required"),
  /** Short-lived token that authorises the /auth/mfa/verify call. */
  mfaToken: z.string(),
  /** TTL hint (seconds) for the client. */
  expiresInSec: z.number().int().positive(),
});
export type MfaRequiredResponse = z.infer<typeof MfaRequiredResponseSchema>;
