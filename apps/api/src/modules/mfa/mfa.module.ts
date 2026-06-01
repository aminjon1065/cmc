import { Module } from "@nestjs/common";
import { MfaService } from "./mfa.service";
import { MfaController } from "./mfa.controller";
import { SecretBoxService } from "../../common/crypto/secret-box.service";

/**
 * MFA module (P1.2 / ADR-0020). Exports MfaService so AuthService can run the
 * login mfa-gate + second-step verification. SecretBoxService is provided here
 * (only MFA needs it today; promote to a shared crypto module if a second
 * consumer appears).
 */
@Module({
  controllers: [MfaController],
  providers: [MfaService, SecretBoxService],
  exports: [MfaService],
})
export class MfaModule {}
