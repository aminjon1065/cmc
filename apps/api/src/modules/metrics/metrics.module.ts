import { Global, Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";

/**
 * Global so any module (notably TenantDatabaseService for the DB
 * transaction gauge) can inject MetricsService without re-importing.
 * The middleware is wired in AppModule's `configure()`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
