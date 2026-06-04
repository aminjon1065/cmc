import { Controller, Get, UseGuards } from "@nestjs/common";
import type { BackupStatusResponse } from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { BackupStatusService } from "./backup-status.service";

/**
 * Ops backup-freshness endpoint (P5.DR / ADR-0074). `GET /v1/ops/backups/status`
 * — gated on `monitoring:read` (ops visibility). Reports the newest Postgres
 * dump + whether it is within the RPO window; the hook for an Alertmanager
 * "no fresh backup" rule (follow-on).
 */
@Controller("ops/backups")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class BackupStatusController {
  constructor(private readonly backups: BackupStatusService) {}

  @Get("status")
  @Authorize("monitoring:read")
  status(): Promise<BackupStatusResponse> {
    return this.backups.status();
  }
}
