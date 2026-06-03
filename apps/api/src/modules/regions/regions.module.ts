import { Module } from "@nestjs/common";
import { RegionsService } from "./regions.service";
import { RegionsController } from "./regions.controller";
import { RegionScopeService } from "./region-scope.service";

/**
 * Regions module (P4.6 / ADR-0064). RegionsService uses TenantDatabaseService +
 * AuditService (both @Global); RegionScopeService also uses RbacService +
 * TenantContextService. Both are exported so the incidents/cases modules can
 * enforce per-region visibility (P4.6b).
 */
@Module({
  controllers: [RegionsController],
  providers: [RegionsService, RegionScopeService],
  exports: [RegionsService, RegionScopeService],
})
export class RegionsModule {}
