import { Module } from "@nestjs/common";
import { IncidentsService } from "./incidents.service";
import { IncidentsController } from "./incidents.controller";
import { NotificationsModule } from "../notifications/notifications.module";

/**
 * Incidents module (P1.5 / ADR-0023). IncidentsService uses TenantDatabaseService
 * + AuditService (both @Global); the controller also uses RbacService (@Global
 * RbacModule) for the transition resolve-gate. Imports NotificationsModule so
 * the service can dispatch on assign/transition (P1.6).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
