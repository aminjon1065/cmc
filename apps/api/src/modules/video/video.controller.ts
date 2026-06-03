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
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  CreateVideoRoomSchema,
  VIDEO_LINK_TYPES,
  type VideoJoinResponse,
  type VideoRecordingDownloadResponse,
  type VideoRecordingResponse,
  type VideoRecordingsListResponse,
  type VideoRoomResponse,
  type VideoRoomsListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { VideoService } from "./video.service";

/**
 * Video conferencing endpoints (P4.2 / ADR-0061). `@Authorize`-gated on
 * `video:*`; RLS confines rooms to the tenant. The join endpoint mints a
 * room-scoped LiveKit token for the caller (the browser never holds the
 * platform JWT — analogous to the collab WS-ticket).
 */
@Controller("video")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class VideoController {
  constructor(private readonly video: VideoService) {}

  private actor(user: TenantContext) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      email: user.email,
    };
  }

  @Get("rooms")
  @Authorize("video:read")
  async list(
    @Query("linkedType") linkedType?: string,
    @Query("linkedId") linkedId?: string,
  ): Promise<VideoRoomsListResponse> {
    // Optional filter: rooms linked to an incident/case (both params required).
    const filter =
      linkedType &&
      linkedId &&
      (VIDEO_LINK_TYPES as readonly string[]).includes(linkedType)
        ? { linkedType: linkedType as (typeof VIDEO_LINK_TYPES)[number], linkedId }
        : undefined;
    return { rooms: await this.video.listRooms(filter) };
  }

  @Post("rooms")
  @Authorize("video:write")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<VideoRoomResponse> {
    let parsed;
    try {
      parsed = CreateVideoRoomSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid video room payload — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return { room: await this.video.createRoom(this.actor(user), parsed) };
  }

  @Get("rooms/:id")
  @Authorize("video:read")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRoomResponse> {
    return { room: await this.video.getRoom(id) };
  }

  @Post("rooms/:id/token")
  @Authorize("video:write")
  @HttpCode(HttpStatus.CREATED)
  async token(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoJoinResponse> {
    return this.video.mintToken(this.actor(user), id);
  }

  @Post("rooms/:id/close")
  @Authorize("video:write")
  @HttpCode(HttpStatus.OK)
  async close(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRoomResponse> {
    return { room: await this.video.closeRoom(this.actor(user), id) };
  }

  // ---------- recordings (P4.2c) ----------

  @Get("rooms/:id/recordings")
  @Authorize("video:read")
  async listRecordings(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRecordingsListResponse> {
    return { recordings: await this.video.listRecordings(id) };
  }

  @Post("rooms/:id/recordings")
  @Authorize("video:manage")
  @HttpCode(HttpStatus.CREATED)
  async startRecording(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRecordingResponse> {
    return { recording: await this.video.startRecording(this.actor(user), id) };
  }

  @Post("recordings/:id/stop")
  @Authorize("video:manage")
  @HttpCode(HttpStatus.OK)
  async stopRecording(
    @CurrentUser() user: TenantContext,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRecordingResponse> {
    return { recording: await this.video.stopRecording(this.actor(user), id) };
  }

  @Get("recordings/:id/download")
  @Authorize("video:read")
  async downloadRecording(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<VideoRecordingDownloadResponse> {
    return { url: await this.video.recordingDownloadUrl(id) };
  }
}
