import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { AdminResetResponse } from "@cmc/contracts";
import { PasswordResetService } from "./password-reset.service";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { AuthRateLimitSpecs } from "../auth/auth-rate-limit.specs";
import { RateLimitService } from "../../common/rate-limit/rate-limit.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Password-reset endpoints (P1.3 / ADR-0021).
 *
 *   POST /auth/password/forgot            (public)  → 204, always
 *   POST /auth/password/reset             (public)  → 204
 *   POST /auth/password/admin-reset/:id   (admin)   → { token, expiresAt }
 */
@Controller("auth/password")
export class PasswordResetController {
  constructor(
    private readonly passwordReset: PasswordResetService,
    private readonly rateLimit: RateLimitService,
    private readonly rateLimitSpecs: AuthRateLimitSpecs,
  ) {}

  /**
   * Self-service request. Returns 204 whether or not the email exists — the
   * response never reveals account existence (no enumeration). Rate-limited
   * per-IP and per-email (anti-spam: each request may send a notification).
   */
  @Post("forgot")
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgot(
    @Body() body: ForgotPasswordDto,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    const userAgent = req.headers["user-agent"] ?? null;
    await this.rateLimit.enforce(
      this.rateLimitSpecs.passwordResetRequestSpecs({
        ip: ip ?? null,
        email: body.email,
        userAgent,
      }),
    );
    await this.passwordReset.requestSelfReset(body.email, {
      ip: ip ?? null,
      userAgent,
    });
  }

  /**
   * Complete a reset with a token (used by both the self-service link and the
   * admin-relayed token). Rate-limited per-IP to bound token brute-force.
   */
  @Post("reset")
  @HttpCode(HttpStatus.NO_CONTENT)
  async reset(
    @Body() body: ResetPasswordDto,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    const userAgent = req.headers["user-agent"] ?? null;
    await this.rateLimit.enforce(
      this.rateLimitSpecs.passwordResetCompleteSpecs({
        ip: ip ?? null,
        userAgent,
      }),
    );
    await this.passwordReset.completeReset(body.token, body.newPassword, {
      ip: ip ?? null,
      userAgent,
    });
  }

  /**
   * Admin-initiated reset for a user in the admin's tenant. Returns the token
   * to the admin to relay out-of-band. Gated by `user:manage`.
   */
  @Post("admin-reset/:userId")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, AuthorizeGuard)
  @Authorize("user:manage")
  async adminReset(
    @CurrentUser() admin: TenantContext,
    @Param("userId", new ParseUUIDPipe()) userId: string,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<AdminResetResponse> {
    const userAgent = req.headers["user-agent"] ?? null;
    return this.passwordReset.requestAdminReset(
      userId,
      { userId: admin.userId, tenantId: admin.tenantId },
      { ip: ip ?? null, userAgent },
    );
  }
}
