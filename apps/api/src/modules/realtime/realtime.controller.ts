import { Controller, Get, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RealtimeStatusResponse } from "@cmc/contracts";
import { RealtimeRegistryService } from "./realtime-registry.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import type { AppConfig } from "../../config/configuration";

/**
 * Realtime gateway ops endpoint (P2.3 / ADR-0035). Gated on `tenant:manage` —
 * connection/subscription counts are process-wide (cross-tenant); a superadmin
 * gate is a later refinement, matching the events/audit ops endpoints.
 */
@Controller("realtime")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class RealtimeController {
  constructor(
    private readonly registry: RealtimeRegistryService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get("status")
  @Authorize("tenant:manage")
  status(): RealtimeStatusResponse {
    const { connections, subscriptions } = this.registry.stats();
    return {
      enabled: this.config.get("REALTIME_ENABLED", { infer: true }),
      connections,
      subscriptions,
    };
  }
}
