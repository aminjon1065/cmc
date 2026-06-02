import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeysService } from "./api-keys.service";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeyQuotaGuard } from "./api-key-quota.guard";

/**
 * API keys module (P3.9 / ADR-0054). Key management CRUD + the global per-key/
 * per-tenant quota guard. Auth-by-key itself lives in TenantContextMiddleware
 * (shared crypto helper); RbacService / RateLimitService / AuditService are all
 * @Global, so no extra imports are needed.
 */
@Module({
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    { provide: APP_GUARD, useClass: ApiKeyQuotaGuard },
  ],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
