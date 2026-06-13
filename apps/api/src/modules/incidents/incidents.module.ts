import { Module } from "@nestjs/common";
import { IncidentsService } from "./incidents.service";
import { IncidentsController } from "./incidents.controller";
import { RegionsModule } from "../regions/regions.module";

/**
 * Incidents module (P1.5 / ADR-0023). IncidentsService uses TenantDatabaseService
 * + AuditService (both @Global) and the global EventEmitter; the controller also
 * uses RbacService (@Global RbacModule) for the transition resolve-gate. Imports
 * RegionsModule for per-region visibility scoping (P4.6b). Notifications are
 * decoupled — emitted as in-process domain events and handled by the
 * incident-notifications listener (ADR-0080).
 */
@Module({
  imports: [RegionsModule],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
