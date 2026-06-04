import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import type { UserPreferencesResponse } from "@cmc/contracts";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { UpdatePreferencesDto } from "./dto/update-preferences.dto";

/**
 * Self-service UI preferences (ADR-0078): any authenticated user reads/updates
 * their OWN persisted theme + locale — no `@Authorize` permission, this is
 * personal (like `/auth/me`). The web seeds its cookies from GET on login and
 * PATCHes on toggle so the choice follows the user across browsers/devices.
 */
@Controller("me/preferences")
@UseGuards(JwtAuthGuard)
export class PreferencesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  get(@CurrentUser() user: TenantContext): Promise<UserPreferencesResponse> {
    return this.users.getMyPreferences(user.userId);
  }

  @Patch()
  update(
    @CurrentUser() user: TenantContext,
    @Body() body: UpdatePreferencesDto,
  ): Promise<UserPreferencesResponse> {
    return this.users.updateMyPreferences(user.userId, body);
  }
}
