import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./modules/health/health.module";
import { DatabaseModule } from "./modules/database/database.module";
import { TenantTransactionInterceptor } from "./modules/database/tenant-transaction.interceptor";
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
  ],
  providers: [
    // Global interceptor: every authenticated HTTP handler runs inside a
    // tenant-scoped transaction with `SET LOCAL app.tenant_id`. RLS does
    // the rest. Anonymous requests (no tenantContext) skip the wrapper
    // and use whatever scope the handler chooses (usually privileged).
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantTransactionInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
