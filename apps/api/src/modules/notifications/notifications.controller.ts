import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationPrefsResponse,
  type NotificationsListResponse,
  type UnreadCountResponse,
} from "@cmc/contracts";
import { NotificationsService } from "./notifications.service";
import { ListNotificationsQuery } from "./dto/list-notifications.query";
import { UpdateNotificationPrefDto } from "./dto/update-pref.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * In-app notification center (P1.6 / ADR-0024). Self-scoped — every route acts
 * on the current user's own notifications, so it needs authentication but no
 * `@Authorize` permission (like `/rbac/me`).
 */
@Controller("notifications")
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: TenantContext,
    @Query() query: ListNotificationsQuery,
  ): Promise<NotificationsListResponse> {
    return this.notifications.listForUser(user.userId, {
      unreadOnly: query.unreadOnly,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get("unread-count")
  async unreadCount(
    @CurrentUser() user: TenantContext,
  ): Promise<UnreadCountResponse> {
    return { unreadCount: await this.notifications.unreadCount(user.userId) };
  }

  @Get("preferences")
  async getPreferences(
    @CurrentUser() user: TenantContext,
  ): Promise<NotificationPrefsResponse> {
    return this.notifications.getPrefs(user.userId);
  }

  @Put("preferences/:kind")
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPreference(
    @CurrentUser() user: TenantContext,
    @Param("kind") kind: string,
    @Body() body: UpdateNotificationPrefDto,
  ): Promise<void> {
    if (!NOTIFICATION_KINDS.includes(kind as NotificationKind)) {
      throw new BadRequestException(`Unknown notification kind: ${kind}`);
    }
    await this.notifications.setPref(user.userId, user.tenantId, kind, {
      inApp: body.inApp,
      email: body.email,
    });
  }

  @Post("read-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: TenantContext): Promise<void> {
    await this.notifications.markAllRead(user.userId);
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.userId, id);
  }
}
