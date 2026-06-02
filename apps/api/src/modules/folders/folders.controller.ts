import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type {
  FolderGrantResponse,
  FolderGrantsListResponse,
  FolderResponse,
  FoldersListResponse,
} from "@cmc/contracts";
import { FoldersService } from "./folders.service";
import { FolderAccessService } from "./folder-access.service";
import { CreateFolderDto } from "./dto/create-folder.dto";
import { RenameFolderDto } from "./dto/rename-folder.dto";
import { MoveFolderDto } from "./dto/move-folder.dto";
import { SetRestrictedDto } from "./dto/set-restricted.dto";
import { CreateGrantDto } from "./dto/create-grant.dto";
import { SetFolderRetentionDto } from "./dto/set-retention.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Folder endpoints (P3.3 / ADR-0047). `folder:*` gated; RLS confines all data to
 * the caller's tenant (cross-tenant id → 404). `GET /` returns the whole tree
 * (flat, parents-before-children); the client builds the hierarchy via `parentId`.
 */
@Controller("folders")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class FoldersController {
  constructor(
    private readonly folders: FoldersService,
    private readonly access: FolderAccessService,
  ) {}

  private actor(user: TenantContext, ip: string, req: Request) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    };
  }

  @Get()
  @Authorize("folder:read")
  async tree(): Promise<FoldersListResponse> {
    return { folders: await this.folders.tree() };
  }

  @Get(":id")
  @Authorize("folder:read")
  async getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<FolderResponse> {
    // 404 if the folder is in a restricted subtree the caller can't read (P3.3b).
    await this.access.assertCanRead(id);
    return { folder: await this.folders.getByIdOrFail(id) };
  }

  @Post()
  @Authorize("folder:write")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateFolderDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return {
      folder: await this.folders.create(
        { name: body.name, parentId: body.parentId ?? null },
        this.actor(user, ip, req),
      ),
    };
  }

  @Patch(":id")
  @Authorize("folder:write")
  async rename(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RenameFolderDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return {
      folder: await this.folders.rename(id, body, this.actor(user, ip, req)),
    };
  }

  @Post(":id/move")
  @Authorize("folder:write")
  @HttpCode(HttpStatus.OK)
  async move(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: MoveFolderDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return {
      folder: await this.folders.move(id, body, this.actor(user, ip, req)),
    };
  }

  @Patch(":id/retention")
  @Authorize("folder:write")
  async setRetention(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SetFolderRetentionDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return {
      folder: await this.folders.setRetention(
        id,
        body.retentionDays,
        this.actor(user, ip, req),
      ),
    };
  }

  // ---------- restriction + grants (P3.3b / ADR-0048; folder:manage) ----------

  @Patch(":id/restrict")
  @Authorize("folder:manage")
  async setRestricted(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SetRestrictedDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderResponse> {
    return {
      folder: await this.folders.setRestricted(
        id,
        body.restricted,
        this.actor(user, ip, req),
      ),
    };
  }

  @Get(":id/grants")
  @Authorize("folder:manage")
  async listGrants(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<FolderGrantsListResponse> {
    return { grants: await this.folders.listGrants(id) };
  }

  @Post(":id/grants")
  @Authorize("folder:manage")
  @HttpCode(HttpStatus.CREATED)
  async addGrant(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: CreateGrantDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<FolderGrantResponse> {
    return {
      grant: await this.folders.addGrant(id, body, this.actor(user, ip, req)),
    };
  }

  @Delete(":id/grants/:grantId")
  @Authorize("folder:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeGrant(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("grantId", new ParseUUIDPipe()) grantId: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.folders.removeGrant(id, grantId, this.actor(user, ip, req));
  }

  @Delete(":id")
  @Authorize("folder:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.folders.remove(id, this.actor(user, ip, req));
  }
}
