import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

/**
 * HealthService injects the DB, Redis, and S3 clients — all registered
 * by @Global() modules — so no extra imports are needed here. JwtAuthGuard
 * (on /health/deep) resolves TenantContextService, which is also global.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
