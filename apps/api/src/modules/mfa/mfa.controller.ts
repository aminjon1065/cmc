import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type {
  MfaBackupCodesResponse,
  MfaEnrolResponse,
  MfaStatusResponse,
} from "@cmc/contracts";
import { MfaService } from "./mfa.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { MfaCodeDto } from "./dto/mfa-code.dto";

/**
 * MFA self-service management (P1.2 / ADR-0020). All routes require an
 * authenticated session — a user manages their OWN factor. The login
 * second-step (`/auth/mfa/verify`) lives on the AuthController instead,
 * because it runs pre-session.
 */
@Controller("auth/mfa")
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /** Current MFA state for the signed-in user. */
  @Get("status")
  async status(@CurrentUser() user: TenantContext): Promise<MfaStatusResponse> {
    return this.mfa.status(user.userId);
  }

  /** Begin TOTP enrolment — returns the secret + QR to add to an app. */
  @Post("enrol")
  @HttpCode(HttpStatus.OK)
  async enrol(@CurrentUser() user: TenantContext): Promise<MfaEnrolResponse> {
    return this.mfa.startEnrolment(user.userId, user.tenantId, user.email);
  }

  /** Confirm enrolment with the first code — returns one-time backup codes. */
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: TenantContext,
    @Body() body: MfaCodeDto,
  ): Promise<MfaBackupCodesResponse> {
    const codes = await this.mfa.confirmEnrolment(
      user.userId,
      user.tenantId,
      body.code,
    );
    if (!codes) {
      throw new UnauthorizedException("Invalid or expired enrolment code");
    }
    return { backupCodes: codes };
  }

  /** Regenerate backup codes (invalidates the old set). */
  @Post("backup-codes/regenerate")
  @HttpCode(HttpStatus.OK)
  async regenerate(
    @CurrentUser() user: TenantContext,
  ): Promise<MfaBackupCodesResponse> {
    const codes = await this.mfa.regenerateBackupCodes(
      user.userId,
      user.tenantId,
    );
    if (!codes) {
      throw new UnauthorizedException("MFA is not enabled");
    }
    return { backupCodes: codes };
  }

  /** Disable MFA after a valid current code (TOTP or backup). */
  @Post("disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(
    @CurrentUser() user: TenantContext,
    @Body() body: MfaCodeDto,
  ): Promise<void> {
    const ok = await this.mfa.disable(user.userId, user.tenantId, body.code);
    if (!ok) {
      throw new UnauthorizedException("Invalid code or MFA not enabled");
    }
  }
}
