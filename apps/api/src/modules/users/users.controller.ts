import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type {
  UserDetailResponse,
  UsersListResponse,
} from "@cmc/contracts";
import { UsersService } from "./users.service";
import { RbacService } from "../rbac/rbac.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Admin user management (P1.4b / ADR-0022). Every route requires
 * `user:manage` — held by `tenant_admin` only. RLS confines all reads/writes
 * to the caller's tenant, so a cross-tenant id is a clean 404.
 *
 * Role assignment uses the existing RBAC endpoints (`/rbac/users/:id/roles`),
 * except at creation time where we grant the initial roles inline (same
 * request transaction as the insert).
 */
@Controller("users")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly rbac: RbacService,
  ) {}

  @Get()
  @Authorize("user:manage")
  async list(): Promise<UsersListResponse> {
    return { users: await this.users.listUsers() };
  }

  @Get(":id")
  @Authorize("user:manage")
  async detail(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<UserDetailResponse> {
    const user = await this.users.getUserDetail(id);
    if (!user) throw new NotFoundException("User not found");
    return { user };
  }

  @Post()
  @Authorize("user:manage")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateUserDto,
    @CurrentUser() admin: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<UserDetailResponse> {
    const actor = {
      actorId: admin.userId,
      tenantId: admin.tenantId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    };

    // Resolve role slugs up front so an unknown slug fails BEFORE we create
    // (and in the same request tx the insert + grants will share).
    let roleIds: string[] = [];
    if (body.roleSlugs && body.roleSlugs.length > 0) {
      const roles = await this.rbac.listRoles();
      const idBySlug = new Map(roles.map((r) => [r.slug, r.id]));
      const unknown = body.roleSlugs.filter((s) => !idBySlug.has(s));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown role(s): ${unknown.join(", ")}`);
      }
      roleIds = [...new Set(body.roleSlugs)].map((s) => idBySlug.get(s)!);
    }

    const created = await this.users.createUser({
      email: body.email,
      name: body.name,
      actor,
    });
    // assignRole uses the ambient request tx, so these grants are visible to,
    // and commit with, the just-inserted user row.
    for (const roleId of roleIds) {
      await this.rbac.assignRole(created.id, roleId);
    }

    const user = await this.users.getUserDetail(created.id);
    return { user: user ?? created };
  }

  @Patch(":id")
  @Authorize("user:manage")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() admin: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<UserDetailResponse> {
    if (body.name === undefined && body.isActive === undefined) {
      throw new BadRequestException("Provide at least one of name or isActive");
    }
    const user = await this.users.updateUser(
      id,
      { name: body.name, isActive: body.isActive },
      {
        actorId: admin.userId,
        tenantId: admin.tenantId,
        ip: ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      },
    );
    return { user };
  }

  @Delete(":id")
  @Authorize("user:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() admin: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.users.softDeleteUser(id, {
      actorId: admin.userId,
      tenantId: admin.tenantId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
  }
}
