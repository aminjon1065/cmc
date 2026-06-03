import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  CreateRegionSchema,
  UpdateRegionSchema,
  type RegionResponse,
  type RegionsListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { RegionsService } from "./regions.service";

/**
 * Region endpoints (P4.6 / ADR-0064). Reads need `region:read`; mutations need
 * `region:manage` (held by tenant_admin). RLS confines all rows to the tenant.
 */
@Controller("regions")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Get()
  @Authorize("region:read")
  async list(): Promise<RegionsListResponse> {
    return { regions: await this.regions.list() };
  }

  @Post()
  @Authorize("region:manage")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<RegionResponse> {
    const parsed = parseBody(CreateRegionSchema, body);
    return {
      region: await this.regions.create(
        { userId: user.userId, tenantId: user.tenantId },
        parsed,
      ),
    };
  }

  @Patch(":id")
  @Authorize("region:manage")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<RegionResponse> {
    const parsed = parseBody(UpdateRegionSchema, body);
    return {
      region: await this.regions.update(
        { userId: user.userId, tenantId: user.tenantId },
        id,
        parsed,
      ),
    };
  }

  @Delete(":id")
  @Authorize("region:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
  ): Promise<void> {
    await this.regions.remove(
      { userId: user.userId, tenantId: user.tenantId },
      id,
    );
  }
}

/** Zod-parse a body, mapping ZodError → 400 (mirrors the other controllers). */
function parseBody<T>(schema: { parse: (v: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        `Invalid region request — ${err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    throw err;
  }
}
