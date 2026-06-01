import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  type TenantBranding,
  UpdateBrandingRequestSchema,
} from "@cmc/contracts";
import { BrandingService } from "./branding.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Branding endpoint (P0.11 / ADR-0018, P1.4d / ADR-0022).
 *
 * `GET` is public + context-aware (authenticated → own tenant; anonymous →
 * default tenant), so it has no guard. `PUT` is admin-only — guarded at the
 * method level (so GET stays open) and gated by `tenant:manage`.
 */
@Controller("branding")
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  async get(): Promise<TenantBranding> {
    return this.branding.resolve();
  }

  @Put()
  @UseGuards(JwtAuthGuard, AuthorizeGuard)
  @Authorize("tenant:manage")
  async update(
    @CurrentUser() user: TenantContext,
    // Validated with the zod contract (the `copy` bag is nested, which
    // class-validator handles awkwardly); the global pipe leaves the raw body
    // intact for an un-typed @Body().
    @Body() rawBody: unknown,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<TenantBranding> {
    const parsed = UpdateBrandingRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.errors.map((e) => e.message).join(", "),
      );
    }
    return this.branding.updateBranding(user.tenantId, parsed.data, {
      actorId: user.userId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
  }
}
