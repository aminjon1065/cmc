import { Global, Module } from "@nestjs/common";
import { RbacService } from "./rbac.service";
import { RbacController } from "./rbac.controller";
import { PermissionCacheService } from "../../common/permission-cache/permission-cache.service";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";

/**
 * Global so the AuthorizeGuard (used across modules via @UseGuards) and
 * RbacService are injectable everywhere without each module re-importing.
 * PermissionCacheService is provided here and used by RbacService.
 */
@Global()
@Module({
  controllers: [RbacController],
  providers: [RbacService, PermissionCacheService, AuthorizeGuard],
  exports: [RbacService, PermissionCacheService, AuthorizeGuard],
})
export class RbacModule {}
