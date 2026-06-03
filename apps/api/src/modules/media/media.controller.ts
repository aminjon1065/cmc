import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  CreateMediaTranscodeSchema,
  type MediaAssetResponse,
  type MediaAssetsListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { MediaService } from "./media.service";

/**
 * Media endpoints (P4.5 / ADR-0063). `@Authorize`-gated on `media:*`; RLS scopes
 * assets to the tenant. The playlist + segment routes are the BFF HLS proxy —
 * RBAC-checked per request, so the browser streams without holding the JWT.
 */
@Controller("media")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post("transcode")
  @Authorize("media:write")
  @HttpCode(HttpStatus.CREATED)
  async transcode(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<MediaAssetResponse> {
    let parsed;
    try {
      parsed = CreateMediaTranscodeSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid media transcode request — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return {
      asset: await this.media.requestTranscode(
        { userId: user.userId, tenantId: user.tenantId },
        parsed.documentId,
        parsed.watermark,
      ),
    };
  }

  @Get("assets")
  @Authorize("media:read")
  async list(
    @Query("documentId") documentId?: string,
  ): Promise<MediaAssetsListResponse> {
    return { assets: await this.media.listAssets(documentId) };
  }

  @Get("assets/:id")
  @Authorize("media:read")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MediaAssetResponse> {
    return { asset: await this.media.getAsset(id) };
  }

  @Get("assets/:id/playlist.m3u8")
  @Authorize("media:read")
  @Header("Content-Type", "application/vnd.apple.mpegurl")
  @Header("Cache-Control", "no-store")
  async playlist(@Param("id", ParseUUIDPipe) id: string): Promise<string> {
    return this.media.getPlaylist(id);
  }

  @Get("assets/:id/seg/:name")
  @Authorize("media:read")
  @Header("Cache-Control", "private, max-age=60")
  async segment(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("name") name: string,
  ): Promise<StreamableFile> {
    const bytes = await this.media.getSegment(id, name);
    return new StreamableFile(bytes, { type: "video/mp2t" });
  }
}
