import { Module } from "@nestjs/common";
import { CasesService } from "./cases.service";
import { CasesController } from "./cases.controller";
import { RegionsModule } from "../regions/regions.module";

/**
 * Cases module (P2.10 / ADR-0040). CasesService uses TenantDatabaseService +
 * AuditService + OutboxService (all @Global); the controller uses RbacService
 * (@Global RbacModule) for the resolve-gate. Imports RegionsModule for
 * per-region visibility scoping (P4.6b).
 */
@Module({
  imports: [RegionsModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
