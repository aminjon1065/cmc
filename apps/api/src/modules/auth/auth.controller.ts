import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type {
  LoginResponse,
  MeResponse,
  RefreshResponse,
  SessionsListResponse,
} from "@cmc/contracts";
import { AuthService } from "./auth.service";
import { SessionsService } from "./sessions.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

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

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: RefreshDto,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<RefreshResponse> {
    return this.auth.refresh({
      refreshToken: body.refreshToken,
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
        name: user.email,
        tenantId: user.tenantId,
        tenantSlug: user.tenantSlug,
      },
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: TenantContext): Promise<void> {
    await this.auth.logout(user.sessionId, user.userId);
  }

  // ---------- Session management ----------

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  async listSessions(
    @CurrentUser() user: TenantContext,
  ): Promise<SessionsListResponse> {
    const rows = await this.sessions.listActiveByUser(user.userId);
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === user.sessionId,
      })),
    };
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentUser() user: TenantContext,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const target = await this.sessions.findById(id);
    if (!target || target.userId !== user.userId) {
      // Surface as 404 either way: do not let a user probe other users'
      // session ids by distinguishing "not yours" from "doesn't exist".
      throw new NotFoundException();
    }
    if (target.id === user.sessionId) {
      // Use POST /auth/logout for that — it has the audit semantics for
      // a user-initiated current-session revoke.
      throw new ForbiddenException(
        "Use /auth/logout to revoke the current session.",
      );
    }
    await this.sessions.revoke(id, "admin");
  }
}
