import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CLICKHOUSE_CLIENT,
  createClickHouseClient,
} from "./clickhouse.client";
import { IncidentProjectionConsumer } from "./incident-projection.consumer";
import { IncidentProjectionSubscriber } from "./incident-projection.subscriber";
import { AuditProjectionService } from "./audit-projection.service";
import { DashboardAnalyticsService } from "./dashboard-analytics.service";
import { AnomalyAlertService } from "./anomaly-alert.service";
import { AnalyticsController } from "./analytics.controller";

/**
 * Analytics plane (P2.5 / ADR-0033). Provides the ClickHouse client (real when
 * `CLICKHOUSE_ENABLED`, else a noop) globally + the incident projection consumer
 * that feeds ClickHouse from the event bus (its subscriber runs when both NATS
 * and ClickHouse are enabled).
 */
@Global()
@Module({
  controllers: [AnalyticsController],
  providers: [
    {
      provide: CLICKHOUSE_CLIENT,
      inject: [ConfigService],
      useFactory: createClickHouseClient,
    },
    IncidentProjectionConsumer,
    IncidentProjectionSubscriber,
    AuditProjectionService,
    DashboardAnalyticsService,
    AnomalyAlertService,
  ],
  exports: [
    CLICKHOUSE_CLIENT,
    IncidentProjectionConsumer,
    AuditProjectionService,
    DashboardAnalyticsService,
    AnomalyAlertService,
  ],
})
export class AnalyticsModule {}
