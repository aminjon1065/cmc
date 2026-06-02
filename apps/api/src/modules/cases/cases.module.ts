import { Module } from "@nestjs/common";
import { CasesService } from "./cases.service";
import { CasesController } from "./cases.controller";

/**
 * Cases module (P2.10 / ADR-0040). CasesService uses TenantDatabaseService +
 * AuditService + OutboxService (all @Global); the controller uses RbacService
 * (@Global RbacModule) for the resolve-gate. No extra imports needed.
 */
@Module({
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
