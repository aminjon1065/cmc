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
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodError, type ZodSchema } from "zod";
import {
  AddChatReactionSchema,
  CreateChatChannelSchema,
  CreateChatMessageSchema,
  UpdateChatMessageSchema,
  type ChatChannelResponse,
  type ChatChannelsListResponse,
  type ChatMessageResponse,
  type ChatMessagesListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { ChatService } from "./chat.service";

function parse<T>(s: ZodSchema<T>, raw: unknown): T {
  try {
    return s.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        `Invalid chat payload — ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    throw err;
  }
}

/**
 * Chat endpoints (P3.12 / ADR-0057). `@Authorize`-gated on `chat:*`; RLS confines
 * rows to the tenant. Channel create/delete is `chat:manage`; posting is
 * `chat:write`; editing/deleting others' messages additionally needs
 * `chat:manage` (enforced in the service).
 */
@Controller("chat")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  // ---------- channels ----------

  @Get("channels")
  @Authorize("chat:read")
  async listChannels(): Promise<ChatChannelsListResponse> {
    return { channels: await this.chat.listChannels() };
  }

  @Post("channels")
  @Authorize("chat:manage")
  @HttpCode(HttpStatus.CREATED)
  async createChannel(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<ChatChannelResponse> {
    return {
      channel: await this.chat.createChannel(
        parse(CreateChatChannelSchema, body),
        { tenantId: user.tenantId, userId: user.userId },
      ),
    };
  }

  @Get("channels/:id")
  @Authorize("chat:read")
  async getChannel(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ChatChannelResponse> {
    return { channel: await this.chat.getChannel(id) };
  }

  @Delete("channels/:id")
  @Authorize("chat:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteChannel(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.chat.deleteChannel(id, {
      tenantId: user.tenantId,
      userId: user.userId,
    });
  }

  // ---------- messages ----------

  @Get("channels/:id/messages")
  @Authorize("chat:read")
  async listMessages(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("limit") limit?: string,
    @Query("before") before?: string,
  ): Promise<ChatMessagesListResponse> {
    return this.chat.listMessages(
      id,
      { tenantId: user.tenantId, userId: user.userId },
      { limit: limit ? Number(limit) : undefined, before: before || undefined },
    );
  }

  @Get("messages/:id/replies")
  @Authorize("chat:read")
  async listReplies(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ChatMessagesListResponse> {
    return this.chat.listReplies(id, {
      tenantId: user.tenantId,
      userId: user.userId,
    });
  }

  @Post("channels/:id/messages")
  @Authorize("chat:write")
  @HttpCode(HttpStatus.CREATED)
  async postMessage(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ChatMessageResponse> {
    return {
      message: await this.chat.postMessage(
        id,
        parse(CreateChatMessageSchema, body),
        { tenantId: user.tenantId, userId: user.userId },
      ),
    };
  }

  @Patch("messages/:id")
  @Authorize("chat:write")
  async updateMessage(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ChatMessageResponse> {
    return {
      message: await this.chat.updateMessage(
        id,
        parse(UpdateChatMessageSchema, body),
        { tenantId: user.tenantId, userId: user.userId },
      ),
    };
  }

  @Delete("messages/:id")
  @Authorize("chat:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMessage(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.chat.deleteMessage(id, {
      tenantId: user.tenantId,
      userId: user.userId,
    });
  }

  // ---------- reactions ----------

  @Post("messages/:id/reactions")
  @Authorize("chat:write")
  @HttpCode(HttpStatus.OK)
  async addReaction(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ChatMessageResponse> {
    const { emoji } = parse(AddChatReactionSchema, body);
    return {
      message: await this.chat.addReaction(id, emoji, {
        tenantId: user.tenantId,
        userId: user.userId,
      }),
    };
  }

  @Delete("messages/:id/reactions/:emoji")
  @Authorize("chat:write")
  async removeReaction(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("emoji") emoji: string,
  ): Promise<ChatMessageResponse> {
    return {
      message: await this.chat.removeReaction(id, decodeURIComponent(emoji), {
        tenantId: user.tenantId,
        userId: user.userId,
      }),
    };
  }
}
