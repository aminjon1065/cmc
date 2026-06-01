/**
 * Pluggable delivery channel for self-service password resets (P1.3 / ADR-0021).
 *
 * The service generates the token and hands it to a `PasswordResetNotifier`;
 * how it reaches the user is the notifier's concern. Today the only binding is
 * {@link DevLogResetNotifier} (logs the link). When the email channel lands in
 * P1.6 we add an SMTP implementation and swap the provider binding in
 * `PasswordResetModule` — one line, no service change.
 */

/** What a notifier needs to deliver a reset to a user. */
export type PasswordResetMessage = {
  /** Recipient email (the account's address). */
  email: string;
  /** Recipient display name, for the message body. */
  name: string;
  /** The opaque, single-use token (plaintext — never logged in prod channels). */
  token: string;
  /** Ready-built link: `${PASSWORD_RESET_URL_BASE}?token=...`. */
  resetUrl: string;
  /** When the token stops working (ISO-8601), for the message copy. */
  expiresAt: string;
};

export interface PasswordResetNotifier {
  sendResetLink(message: PasswordResetMessage): Promise<void>;
}

/** DI token — `PasswordResetNotifier` is an interface, so we bind by symbol. */
export const PASSWORD_RESET_NOTIFIER = Symbol("PASSWORD_RESET_NOTIFIER");
