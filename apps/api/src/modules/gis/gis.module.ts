import { Module } from "@nestjs/common";
import { GisService } from "./gis.service";
import { GisController } from "./gis.controller";

/**
 * GIS module (P2.7 / ADR-0037). GisService uses TenantDatabaseService +
 * AuditService (both @Global); the controller's RBAC guard resolves via the
 * @Global RbacModule. No extra imports needed.
 */
@Module({
  controllers: [GisController],
  providers: [GisService],
  exports: [GisService],
})
export class GisModule {}
