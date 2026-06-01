import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  AuditAnchorResponse,
  AuditChainVerifyResponse,
  AuditExportFlushResponse,
  AuditExportStatusResponse,
  AuditProjectionFlushResponse,
  AuditProjectionStatusResponse,
  AuditSealResponse,
} from "@cmc/contracts";
import { AuditChainService } from "./audit-chain.service";
import { AuditExportService } from "./audit-export.service";
import { AuditProjectionService } from "../analytics/audit-projection.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Audit hash-chain compliance endpoints (P1.11 / ADR-0029). Gated on
 * `tenant:manage` — verification reads the caller's OWN tenant chain only (the
 * tenant-less `system` chain is platform-superadmin territory, not exposed
 * here). Sealing is idempotent + side-effect-only (computes hashes), so it's a
 * safe maintenance action for an admin to trigger.
 */
@Controller("audit")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class AuditController {
  constructor(
    private readonly chain: AuditChainService,
    private readonly exporter: AuditExportService,
    private readonly projection: AuditProjectionService,
  ) {}

  /** Verify the caller's tenant chain for a UTC day (`?date=YYYY-MM-DD`, default today). */
  @Get("chain/verify")
  @Authorize("tenant:manage")
  async verify(
    @CurrentUser() user: TenantContext,
    @Query("date") date?: string,
  ): Promise<AuditChainVerifyResponse> {
    return this.chain.verifyChain(user.tenantId, this.resolveDay(date));
  }

  /** Force a seal pass (fills hashes for any pending rows). Returns counts. */
  @Post("chain/seal")
  @HttpCode(HttpStatus.OK)
  @Authorize("tenant:manage")
  async seal(): Promise<AuditSealResponse> {
    return this.chain.sealPendingChains();
  }

  /**
   * Anchor the caller's tenant chain for a day: seal it, Merkle-root it, and
   * write the root to object storage under Object Lock (WORM). Idempotent.
   */
  @Post("chain/anchor")
  @HttpCode(HttpStatus.OK)
  @Authorize("tenant:manage")
  async anchor(
    @CurrentUser() user: TenantContext,
    @Query("date") date?: string,
  ): Promise<AuditAnchorResponse> {
    const day = this.resolveDay(date);
    await this.chain.sealPendingChains();
    const res = await this.chain.anchorChain(user.tenantId, day);
    if (!res) {
      throw new NotFoundException(`No sealed audit rows to anchor for ${day}`);
    }
    return res;
  }

  /** SIEM export status: cursor position, pending rows, format, transport. */
  @Get("export/status")
  @Authorize("tenant:manage")
  async exportStatus(): Promise<AuditExportStatusResponse> {
    return this.exporter.status();
  }

  /** Ship the next batch of unexported audit rows to the SIEM sink. */
  @Post("export/flush")
  @HttpCode(HttpStatus.OK)
  @Authorize("tenant:manage")
  async exportFlush(): Promise<AuditExportFlushResponse> {
    return this.exporter.flush();
  }

  /** Audit→ClickHouse projection status: cursor, pending, CH reachable. */
  @Get("projection/status")
  @Authorize("tenant:manage")
  async projectionStatus(): Promise<AuditProjectionStatusResponse> {
    return this.projection.status();
  }

  /** Project the next batch of audit rows into ClickHouse. */
  @Post("projection/flush")
  @HttpCode(HttpStatus.OK)
  @Authorize("tenant:manage")
  async projectionFlush(): Promise<AuditProjectionFlushResponse> {
    return this.projection.flush();
  }

  private resolveDay(date?: string): string {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Date().toISOString().slice(0, 10);
  }
}
