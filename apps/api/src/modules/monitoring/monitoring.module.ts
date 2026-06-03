import { Module } from "@nestjs/common";
import { MonitoringService } from "./monitoring.service";
import { MonitoringController } from "./monitoring.controller";

/**
 * Operational Monitoring Center module (P4.3 / ADR-0062). MonitoringService
 * aggregates the wall snapshot + audit_log replay from Postgres (via the
 * @Global TenantDatabaseService); no extra dependencies.
 */
@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
