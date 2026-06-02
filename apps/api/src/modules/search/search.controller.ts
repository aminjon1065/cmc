import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import type { SearchResponse } from "@cmc/contracts";
import { SearchService } from "./search.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Cross-domain search (P2.11 / ADR-0041). Authenticated only — there's no single
 * permission gate; the service filters per domain by the caller's read perms
 * (incident/case/document), and RLS confines results to the tenant.
 */
@Controller("search")
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(
    @CurrentUser() user: TenantContext,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ): Promise<SearchResponse> {
    const parsed = limit ? Number.parseInt(limit, 10) : NaN;
    return this.searchService.search(
      user.tenantId,
      user.userId,
      q ?? "",
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }
}
