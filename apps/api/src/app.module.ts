import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { HealthModule } from "./modules/health/health.module";
import { DatabaseModule } from "./modules/database/database.module";
import { TenantTransactionInterceptor } from "./modules/database/tenant-transaction.interceptor";
import { RedisModule } from "./modules/redis/redis.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { SessionCacheModule } from "./common/session-cache/session-cache.module";
import { AuditModule } from "./modules/audit/audit.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { UsersModule } from "./modules/users/users.module";
import { AuthModule } from "./modules/auth/auth.module";
import { StorageModule } from "./modules/storage/storage.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { TenantContextModule } from "./common/tenant-context/tenant-context.module";
import { TenantContextMiddleware } from "./common/tenant-context/tenant-context.middleware";
import { TenantContextService } from "./common/tenant-context/tenant-context.service";
import { RequestContextModule } from "./common/request-context/request-context.module";
import { RequestContextMiddleware } from "./common/request-context/request-context.middleware";
import { RequestContextService } from "./common/request-context/request-context.service";
import { buildPinoOptions } from "./common/logging/pino-options";
import type { AppConfig } from "./config/configuration";
import { loadConfig } from "./config/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadConfig(),
    }),

    // RequestContextModule must be imported BEFORE LoggerModule because
    // pino's `customProps` reads RequestContextService at log time.
    RequestContextModule,
    TenantContextModule,

    // Structured logging (P0.3 / ADR-0010). Reads NODE_ENV + LOG_LEVEL
    // from config; pretty in dev, JSON in prod; injects request_id +
    // tenantId + userId from ALS on every log line.
    LoggerModule.forRootAsync({
      inject: [ConfigService, RequestContextService, TenantContextService],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        requestContext: RequestContextService,
        tenantContext: TenantContextService,
      ) =>
        buildPinoOptions(
          config.get("NODE_ENV", { infer: true }),
          config.get("LOG_LEVEL", { infer: true }),
          requestContext,
          tenantContext,
        ),
    }),

    // --- Cross-cutting infrastructure ---
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    SessionCacheModule,
    AuditModule,
    StorageModule,

    // --- Domain modules ---
    HealthModule,
    TenantsModule,
    UsersModule,
    AuthModule,
    DocumentsModule,
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
    // Order matters: RequestContextMiddleware runs first so request_id
    // is available to the durable-audit path in TenantContextMiddleware
    // (e.g. JWT verification failure that still wants to audit the
    // request_id of the rejected call).
    consumer
      .apply(RequestContextMiddleware, TenantContextMiddleware)
      .forRoutes("*");
  }
}
