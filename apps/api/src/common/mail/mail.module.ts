import { Global, Module } from "@nestjs/common";
import { MailService } from "./mail.service";

/**
 * Global mail module (P1.6c / ADR-0024) so any module (password reset,
 * notifications) can inject MailService without a local import.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
