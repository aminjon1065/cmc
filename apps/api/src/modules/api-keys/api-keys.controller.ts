import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  ApiKeyCreatedResponse,
  ApiKeysListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { ApiKeysService } from "./api-keys.service";

/**
 * API key management (P3.9a / ADR-0054). `api_key:manage`-gated. Key management
 * is **user-only**: an API-key principal is rejected here so a key can never
 * mint or revoke other keys (lateral-escalation guard) — even though the data
 * model would already cap a minted key's scopes at the creator's.
 */
@Controller("api-keys")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  private assertUser(user: TenantContext): void {
    if (user.principalType === "apikey") {
      throw new ForbiddenException("API keys cannot manage API keys.");
    }
  }

  @Get()
  @Authorize("api_key:manage")
  async list(@CurrentUser() user: TenantContext): Promise<ApiKeysListResponse> {
    this.assertUser(user);
    return { apiKeys: await this.apiKeys.list() };
  }

  @Post()
  @Authorize("api_key:manage")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<ApiKeyCreatedResponse> {
    this.assertUser(user);
    return this.apiKeys.create(body);
  }

  @Delete(":id")
  @Authorize("api_key:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    this.assertUser(user);
    await this.apiKeys.revoke(id);
  }
}
