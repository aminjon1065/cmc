import { Module } from "@nestjs/common";
import { DashboardAnalyticsService } from "./dashboard-analytics.service";
import { AnalyticsController } from "./analytics.controller";
import { RegionsModule } from "../regions/regions.module";

/**
 * Analytics plane (ToR v2.0 §5). Operational dashboards computed from
 * **PostgreSQL** — the incident-volume trend, RLS + region scoped. ClickHouse,
 * the audit/incident projections, and the realtime-anomaly detector were removed
 * in ADR-0080 (ClickHouse returns only as a read-only downstream sink if Postgres
 * aggregation becomes a measured bottleneck — ToR §12).
 */
@Module({
  imports: [RegionsModule],
  controllers: [AnalyticsController],
  providers: [DashboardAnalyticsService],
  exports: [DashboardAnalyticsService],
})
export class AnalyticsModule {}
