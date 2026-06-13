import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { DashboardAnalyticsResponse } from "@cmc/contracts";
import { DashboardAnalyticsService } from "./dashboard-analytics.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";

/**
 * Analytics / dashboard metrics (ToR v2.0 §5). PostgreSQL-backed historical
 * trends, RLS + region scoped, gated on `incident:read` (the trend is incident
 * data). ClickHouse + the anomaly plane were removed in ADR-0080.
 */
@Controller("analytics")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class AnalyticsController {
  constructor(private readonly dashboard: DashboardAnalyticsService) {}

  /** Dashboard metrics — incident trend over a window (default 14 days). */
  @Get("dashboard")
  @Authorize("incident:read")
  async dashboardMetrics(
    @Query("days") days?: string,
  ): Promise<DashboardAnalyticsResponse> {
    const parsed = days ? Number.parseInt(days, 10) : NaN;
    return this.dashboard.dashboard(
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }
}
