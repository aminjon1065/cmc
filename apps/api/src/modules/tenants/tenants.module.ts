import { Module } from "@nestjs/common";
import { TenantsService } from "./tenants.service";
import { TenantsController } from "./tenants.controller";

/**
 * TenantsService (consumed by AuthModule for the login tenant lookup) +
 * the admin TenantsController (P1.4d). AuditService comes from its @Global
 * module; AuthorizeGuard from the @Global RbacModule.
 */
@Module({
  providers: [TenantsService],
  controllers: [TenantsController],
  exports: [TenantsService],
})
export class TenantsModule {}
