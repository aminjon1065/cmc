import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  MyAccessResponse,
  PermissionCatalogResponse,
  RoleDetailResponse,
  RolesListResponse,
  UserRolesResponse,
} from "@cmc/contracts";
import { RbacService } from "./rbac.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { AssignRoleDto } from "./dto/assign-role.dto";
import { CreateRoleDto } from "./dto/create-role.dto";
import { UpdateRoleDto } from "./dto/update-role.dto";

/**
 * RBAC administration endpoints (P1.1 / ADR-0019).
 *
 * Every route requires authentication (JwtAuthGuard) AND a permission
 * (AuthorizeGuard via @Authorize). Reading roles needs `role:read`; changing
 * assignments needs `role:assign` — so a tenant_admin can manage roles while
 * an operator cannot.
 */
@Controller("rbac")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  /**
   * The CURRENT user's effective roles + permissions. No `@Authorize` — every
   * authenticated user may read their own access. The web app calls this to
   * gate the `/admin/*` section and decide which nav to show.
   */
  @Get("me")
  async myAccess(@CurrentUser() user: TenantContext): Promise<MyAccessResponse> {
    const roles = await this.rbac.listUserRoles(user.userId);
    const permissions = await this.rbac.resolvePermissions(
      user.tenantId,
      user.userId,
    );
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      roles,
      permissions: [...permissions].sort(),
    };
  }

  /** The global permission catalog (for the role editor). */
  @Get("permissions")
  @Authorize("role:read")
  getPermissions(): PermissionCatalogResponse {
    return this.rbac.getPermissionCatalog();
  }

  /** List the tenant's roles with their permissions. */
  @Get("roles")
  @Authorize("role:read")
  async listRoles(): Promise<RolesListResponse> {
    return { roles: await this.rbac.listRoles() };
  }

  /** A single role with its permissions. */
  @Get("roles/:id")
  @Authorize("role:read")
  async getRole(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<RoleDetailResponse> {
    const role = await this.rbac.getRole(id);
    if (!role) throw new NotFoundException("Role not found");
    return { role };
  }

  /** Create a custom role. */
  @Post("roles")
  @Authorize("role:manage")
  @HttpCode(HttpStatus.CREATED)
  async createRole(@Body() body: CreateRoleDto): Promise<RoleDetailResponse> {
    const role = await this.rbac.createRole({
      slug: body.slug,
      name: body.name,
      description: body.description,
      permissions: body.permissions,
    });
    return { role };
  }

  /** Update a custom role (system roles are immutable). */
  @Patch("roles/:id")
  @Authorize("role:manage")
  async updateRole(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateRoleDto,
  ): Promise<RoleDetailResponse> {
    if (
      body.name === undefined &&
      body.description === undefined &&
      body.permissions === undefined
    ) {
      throw new BadRequestException(
        "Provide at least one of name, description, or permissions",
      );
    }
    const role = await this.rbac.updateRole(id, {
      name: body.name,
      description: body.description,
      permissions: body.permissions,
    });
    return { role };
  }

  /** Delete a custom role (system roles cannot be deleted). */
  @Delete("roles/:id")
  @Authorize("role:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRole(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.rbac.deleteRole(id);
  }

  /** List the roles assigned to a user. */
  @Get("users/:id/roles")
  @Authorize("role:read")
  async listUserRoles(
    @Param("id", ParseUUIDPipe) userId: string,
  ): Promise<UserRolesResponse> {
    return { userId, roles: await this.rbac.listUserRoles(userId) };
  }

  /** Assign a role to a user. */
  @Post("users/:id/roles")
  @Authorize("role:assign")
  @HttpCode(HttpStatus.NO_CONTENT)
  async assignRole(
    @Param("id", ParseUUIDPipe) userId: string,
    @Body() body: AssignRoleDto,
  ): Promise<void> {
    await this.rbac.assignRole(userId, body.roleId);
  }

  /** Remove a role from a user. */
  @Delete("users/:id/roles/:roleId")
  @Authorize("role:assign")
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRole(
    @Param("id", ParseUUIDPipe) userId: string,
    @Param("roleId", ParseUUIDPipe) roleId: string,
  ): Promise<void> {
    await this.rbac.removeRole(userId, roleId);
  }
}
