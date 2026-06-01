import { Global, Module, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase, type Database } from "@cmc/db";
import type { AppConfig } from "../../config/configuration";
import { DB } from "./database.tokens";
import { TenantDatabaseService } from "./tenant-database.service";
import { TenantTransactionInterceptor } from "./tenant-transaction.interceptor";
import { MetricsService } from "../metrics/metrics.service";

// Re-export so existing `import { DB } from "./database.module"` code keeps
// working. The actual symbol lives in database.tokens.ts to break the
// circular import with TenantDatabaseService.
export { DB };

class DatabaseLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger("Database");

  constructor(private readonly database: Database) {}

  async onModuleDestroy() {
    this.logger.log("Closing database connections...");
    await this.database.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const url = config.get("DATABASE_URL", { infer: true });
        return createDatabase(url, { max: 20, idleTimeout: 30 });
      },
    },
    {
      provide: DatabaseLifecycle,
      inject: [DB],
      useFactory: (database: Database) => new DatabaseLifecycle(database),
    },
    {
      // Publish the configured pool max to the metrics registry once at
      // boot (P0.7). A side-effect-only provider; Nest instantiates every
      // provider of an eagerly-loaded module, so the factory runs at boot.
      provide: "DB_POOL_MAX_METRIC",
      inject: [MetricsService],
      useFactory: (metrics: MetricsService) => {
        // Keep in sync with the `max: 20` passed to createDatabase below.
        // (When DB_POOL_MAX becomes configurable this reads from config.)
        metrics.setDbPoolMax(20);
        return true;
      },
    },
    TenantDatabaseService,
    TenantTransactionInterceptor,
  ],
  exports: [DB, TenantDatabaseService, TenantTransactionInterceptor],
})
export class DatabaseModule {}
