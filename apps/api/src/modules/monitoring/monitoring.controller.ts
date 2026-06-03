import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  MonitoringReplayResponse,
  MonitoringSummaryResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { MonitoringService } from "./monitoring.service";

const MAX_REPLAY = 2000;
const DEFAULT_REPLAY = 500;

/**
 * Operational Monitoring Center endpoints (P4.3 / ADR-0062). `monitoring:read`-
 * gated; RLS scopes everything to the tenant. `summary` is polled by the wall;
 * `replay` returns the audit_log timeline over a window.
 */
@Controller("monitoring")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get("summary")
  @Authorize("monitoring:read")
  async summary(): Promise<MonitoringSummaryResponse> {
    return { summary: await this.monitoring.summary() };
  }

  @Get("replay")
  @Authorize("monitoring:read")
  async replay(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ): Promise<MonitoringReplayResponse> {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException("from/to must be ISO timestamps.");
    }
    if (fromDate > toDate) {
      throw new BadRequestException("from must be before to.");
    }
    const n = limit ? Number.parseInt(limit, 10) : DEFAULT_REPLAY;
    const capped = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_REPLAY) : DEFAULT_REPLAY;
    return this.monitoring.replay(fromDate, toDate, capped);
  }
}
