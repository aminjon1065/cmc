import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type {
  AnomaliesResponse,
  DashboardAnalyticsResponse,
} from "@cmc/contracts";
import { DashboardAnalyticsService } from "./dashboard-analytics.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Analytics / dashboard metrics (P2.6 / ADR-0036). ClickHouse-backed historical
 * data, tenant-scoped, gated on `incident:read` (the trend is incident data).
 */
@Controller("analytics")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class AnalyticsController {
  constructor(private readonly dashboard: DashboardAnalyticsService) {}

  /** Dashboard metrics — incident trend over a window (default 14 days). */
  @Get("dashboard")
  @Authorize("incident:read")
  async dashboardMetrics(
    @CurrentUser() user: TenantContext,
    @Query("days") days?: string,
  ): Promise<DashboardAnalyticsResponse> {
    const parsed = days ? Number.parseInt(days, 10) : NaN;
    return this.dashboard.dashboard(
      user.tenantId,
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  /**
   * Realtime anomaly detection (P4.8 / ADR-0066) — incident-volume days that
   * deviate from the recent rolling baseline (Z-score). ClickHouse-backed,
   * tenant-scoped; degrades to `source: "unavailable"` when CH is off.
   */
  @Get("anomalies")
  @Authorize("incident:read")
  async anomalies(
    @CurrentUser() user: TenantContext,
    @Query("days") days?: string,
    @Query("window") window?: string,
    @Query("z") z?: string,
  ): Promise<AnomaliesResponse> {
    const num = (v?: string) => {
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    return this.dashboard.anomalies(user.tenantId, {
      days: num(days),
      window: num(window),
      zThreshold: num(z),
    });
  }
}
