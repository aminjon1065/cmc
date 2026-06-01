import { Injectable } from "@nestjs/common";
import { MailService } from "../../common/mail/mail.service";
import { buildResetEmail } from "../../common/mail/templates";
import type {
  PasswordResetMessage,
  PasswordResetNotifier,
} from "./password-reset.notifier";

/**
 * Email password-reset channel (P1.6c / ADR-0024) — replaces the dev-logger
 * binding from P1.3. Sends the reset link via MailService (Mailpit in dev, real
 * SMTP in prod). Best-effort: MailService never throws, and when mail is
 * disabled it logs in dev / warns+drops in prod.
 */
@Injectable()
export class EmailResetNotifier implements PasswordResetNotifier {
  constructor(private readonly mail: MailService) {}

  async sendResetLink(message: PasswordResetMessage): Promise<void> {
    const { subject, html, text } = buildResetEmail({
      name: message.name,
      resetUrl: message.resetUrl,
      expiresAt: message.expiresAt,
    });
    await this.mail.send({ to: message.email, subject, html, text });
  }
}
