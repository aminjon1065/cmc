import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./modules/health/health.module";
import { DatabaseModule } from "./modules/database/database.module";
import { AuditModule } from "./modules/audit/audit.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { UsersModule } from "./modules/users/users.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TenantContextModule } from "./common/tenant-context/tenant-context.module";
import { TenantContextMiddleware } from "./common/tenant-context/tenant-context.middleware";
import { loadConfig } from "./config/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadConfig(),
    }),

    // --- Cross-cutting infrastructure ---
    DatabaseModule,
    TenantContextModule,
    AuditModule,

    // --- Domain modules ---
    HealthModule,
    TenantsModule,
    UsersModule,
    AuthModule,
    // Each new bounded context gets its own module under src/modules/<name>/
    // and is added here. Modules must not import each other's internals;
    // cross-module collaboration goes through public services or events.
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Run on every route — establishes tenant context if a valid JWT is
    // present, else passes through anonymously. Guards on individual routes
    // enforce auth where required.
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
