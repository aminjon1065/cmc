import { Module } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";
import { NotificationsController } from "./notifications.controller";

/**
 * Notifications module (P1.6 / ADR-0024). Exports NotificationsService so
 * IncidentsModule can dispatch on incident events. TenantDatabaseService comes
 * from its @Global module, so no imports are needed.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
