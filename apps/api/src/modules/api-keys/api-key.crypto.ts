import { createHash, randomBytes } from "crypto";

/** Public prefix on every API key secret — distinguishes keys from JWTs. */
export const API_KEY_PREFIX = "cmc_";

/**
 * Mint a new API key secret. Returns the full `secret` (shown to the caller
 * once) and a public `displayPrefix` (safe to store + show in lists). The
 * secret is 32 url-safe random chars after the prefix.
 */
export function generateApiKey(): { secret: string; displayPrefix: string } {
  const raw = randomBytes(24).toString("base64url"); // 32 chars
  const secret = `${API_KEY_PREFIX}${raw}`;
  return { secret, displayPrefix: secret.slice(0, 12) }; // cmc_ + 8 chars
}

/**
 * SHA-256 hex of the full secret — what we store + look up by. SHA-256 (not a
 * slow KDF) is appropriate here: the secret is 32 high-entropy random chars, so
 * there's nothing to brute-force, and auth must be a fast indexed lookup.
 */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Whether a presented credential looks like one of our API keys. */
export function isApiKey(candidate: string): boolean {
  return candidate.startsWith(API_KEY_PREFIX);
}
