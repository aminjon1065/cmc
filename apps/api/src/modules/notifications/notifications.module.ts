import { Global, Module } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";

/**
 * Notifications module (P1.6 / ADR-0024). @Global so any module can inject
 * NotificationsService — IncidentsModule (event dispatch) and the Temporal
 * incident-response worker (P3.2 / ADR-0046). TenantDatabaseService comes from
 * its own @Global module, so no imports are needed.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
