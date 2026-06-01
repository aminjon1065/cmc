import { Module } from "@nestjs/common";
import { PasswordResetService } from "./password-reset.service";
import { PasswordResetController } from "./password-reset.controller";
import { EmailResetNotifier } from "./email.notifier";
import { PASSWORD_RESET_NOTIFIER } from "./password-reset.notifier";
import { UsersModule } from "../users/users.module";
import { AuthModule } from "../auth/auth.module";

/**
 * Password-reset module (P1.3 / ADR-0021, P1.6c / ADR-0024).
 *
 * Pulls UsersService (UsersModule) + SessionsService/AuthRateLimitSpecs
 * (AuthModule); AuditService, RateLimitService, AuthorizeGuard, and MailService
 * come from their global modules. The delivery channel is bound behind the
 * PASSWORD_RESET_NOTIFIER token — now `EmailResetNotifier` (SMTP via Mailpit in
 * dev), swapped from the P1.3 dev-logger. MailService itself logs in dev /
 * warns+drops in prod when mail is disabled, preserving the dev visibility.
 */
@Module({
  imports: [UsersModule, AuthModule],
  controllers: [PasswordResetController],
  providers: [
    PasswordResetService,
    { provide: PASSWORD_RESET_NOTIFIER, useClass: EmailResetNotifier },
  ],
})
export class PasswordResetModule {}
