import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./modules/health/health.module";
import { loadConfig } from "./config/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Single source of truth for env validation — see config/configuration.ts.
      validate: () => loadConfig(),
    }),

    // --- Domain modules ---
    HealthModule,
    // Each new bounded context gets its own module under src/modules/<name>/
    // and is added here. Modules must not import each other's internals;
    // cross-module collaboration goes through public services or events.
  ],
})
export class AppModule {}
