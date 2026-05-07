import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { LoginResponse, MeResponse } from "@cmc/contracts";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    return this.auth.login({
      email: body.email,
      password: body.password,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: TenantContext): MeResponse {
    return {
      user: {
        id: user.userId,
        email: user.email,
        name: user.email, // name not in JWT yet; placeholder until /me hits DB
        tenantId: user.tenantId,
        tenantSlug: user.tenantSlug,
      },
    };
  }

  /**
   * Stateless logout. With a non-revocable JWT there is nothing the server
   * can do here — the client clears its cookie and the token expires
   * naturally. Endpoint exists so the web can call it for symmetry and so
   * we can record the audit trail.
   *
   * Server-side revocation arrives with the refresh-token + sessions table
   * iteration.
   */
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() _user: TenantContext): void {
    // intentionally empty for now
  }
}
