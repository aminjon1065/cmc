import {
  Body,
  Controller,
  Get,
  Ip,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { TenantSettingsResponse } from "@cmc/contracts";
import { TenantsService } from "./tenants.service";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Tenant self-settings (P1.4d / ADR-0022). A tenant_admin edits ONLY their own
 * tenant — the id always comes from the auth context, never the request — so
 * there's no tenant id in the routes. Gated by `tenant:manage`.
 */
@Controller("tenant")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Authorize("tenant:manage")
  async get(
    @CurrentUser() user: TenantContext,
  ): Promise<TenantSettingsResponse> {
    const t = await this.tenants.getByIdOrFail(user.tenantId);
    return { id: t.id, slug: t.slug, name: t.name };
  }

  @Patch()
  @Authorize("tenant:manage")
  async update(
    @CurrentUser() user: TenantContext,
    @Body() body: UpdateTenantDto,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<TenantSettingsResponse> {
    const t = await this.tenants.updateTenant(
      user.tenantId,
      { name: body.name },
      {
        actorId: user.userId,
        ip: ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      },
    );
    return { id: t.id, slug: t.slug, name: t.name };
  }
}
