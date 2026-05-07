import { Global, Module, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase, type Database } from "@cmc/db";
import type { AppConfig } from "../../config/configuration";

/**
 * Token used for DI of the Drizzle database. Inject with `@Inject(DB)`.
 */
export const DB = Symbol("CMC_DB");

class DatabaseLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger("Database");

  constructor(private readonly database: Database) {}

  async onModuleDestroy() {
    this.logger.log("Closing database connections...");
    await this.database.close();
  }
}

/**
 * Global database module. The Drizzle client is created once at app boot and
 * reused across all modules. Injection token: `DB`.
 */
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
  ],
  exports: [DB],
})
export class DatabaseModule {}
