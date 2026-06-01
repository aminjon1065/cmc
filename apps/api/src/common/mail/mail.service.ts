import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type Transporter } from "nodemailer";
import type { AppConfig } from "../../config/configuration";

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/**
 * SMTP mail sender (P1.6c / ADR-0024) — Nodemailer over `MAIL_*`.
 *
 * Best-effort: `send` NEVER throws (so a notification/email hiccup can't fail
 * the triggering operation). When mail is disabled (or unconfigured), it
 * **logs the message in dev** (so you can see/copy a reset link without an SMTP
 * server) but **warns + drops in production** — reset links must never hit prod
 * stdout (preserves the P1.3 prod-safety). Dev points `MAIL_*` at Mailpit.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger("Mail");
  private readonly isProd: boolean;
  private readonly from: string;
  private readonly transporter: Transporter | null;

  constructor(config: ConfigService<AppConfig, true>) {
    this.isProd = config.get("NODE_ENV", { infer: true }) === "production";
    this.from = config.get("MAIL_FROM", { infer: true });
    const enabled = config.get("MAIL_ENABLED", { infer: true });
    const host = config.get("MAIL_HOST", { infer: true });

    if (enabled && host) {
      const user = config.get("MAIL_USER", { infer: true });
      const pass = config.get("MAIL_PASS", { infer: true });
      this.transporter = createTransport({
        host,
        port: config.get("MAIL_PORT", { infer: true }),
        secure: config.get("MAIL_SECURE", { infer: true }),
        auth: user ? { user, pass: pass ?? "" } : undefined,
      });
    } else {
      this.transporter = null;
    }
  }

  /** Best-effort send. Returns true iff handed off to the SMTP server. */
  async send(msg: MailMessage): Promise<boolean> {
    const text = msg.text ?? stripHtml(msg.html);
    if (!this.transporter) {
      this.logDevOrWarn(msg, text);
      return false;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text,
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `mail send to ${msg.to} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // In dev, surface the content so the flow isn't blocked by a down SMTP.
      if (!this.isProd) this.logDevOrWarn(msg, text);
      return false;
    }
  }

  private logDevOrWarn(msg: MailMessage, text: string): void {
    if (this.isProd) {
      this.logger.warn(
        `mail disabled — dropping "${msg.subject}" to ${msg.to}`,
      );
    } else {
      this.logger.log(
        `[mail:dev] to=${msg.to} subject="${msg.subject}"\n${text}`,
      );
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
