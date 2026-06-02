import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
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
import { PreviewsModule } from "./modules/previews/previews.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { FoldersModule } from "./modules/folders/folders.module";
import { BrandingModule } from "./modules/branding/branding.module";
import { RbacModule } from "./modules/rbac/rbac.module";
import { MfaModule } from "./modules/mfa/mfa.module";
import { PasswordResetModule } from "./modules/password-reset/password-reset.module";
import { IncidentsModule } from "./modules/incidents/incidents.module";
import { CasesModule } from "./modules/cases/cases.module";
import { GisModule } from "./modules/gis/gis.module";
import { SearchModule } from "./modules/search/search.module";
import { WorkflowsModule } from "./modules/workflows/workflows.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { IncidentNotificationsModule } from "./modules/incident-notifications/incident-notifications.module";
import { OpenApiModule } from "./modules/openapi/openapi.module";
import { MailModule } from "./common/mail/mail.module";
import { EventsModule } from "./modules/events/events.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { TemporalModule } from "./modules/temporal/temporal.module";
import { TenantContextModule } from "./common/tenant-context/tenant-context.module";
import { TenantContextMiddleware } from "./common/tenant-context/tenant-context.middleware";
import { TenantContextService } from "./common/tenant-context/tenant-context.service";
import { RequestContextModule } from "./common/request-context/request-context.module";
import { RequestContextMiddleware } from "./common/request-context/request-context.middleware";
import { RequestContextService } from "./common/request-context/request-context.service";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { MetricsMiddleware } from "./modules/metrics/metrics.middleware";
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

    // Cron scheduler (P1.11b / ADR-0029) — daily audit Merkle anchoring.
    ScheduleModule.forRoot(),

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
          config.get("LOKI_URL", { infer: true }),
        ),
    }),

    // --- Cross-cutting infrastructure ---
    // MetricsModule is global and listed before DatabaseModule because
    // TenantDatabaseService injects MetricsService for the DB tx gauge.
    MetricsModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    SessionCacheModule,
    AuditModule,
    StorageModule,
    PreviewsModule,
    RbacModule,
    MailModule,
    EventsModule,
    AnalyticsModule,
    RealtimeModule,
    TemporalModule,

    // --- Domain modules ---
    HealthModule,
    TenantsModule,
    UsersModule,
    MfaModule,
    AuthModule,
    PasswordResetModule,
    DocumentsModule,
    FoldersModule,
    BrandingModule,
    IncidentsModule,
    CasesModule,
    GisModule,
    SearchModule,
    WorkflowsModule,
    ApiKeysModule,
    NotificationsModule,
    IncidentNotificationsModule,
    OpenApiModule,
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
    // Order matters:
    //   1. MetricsMiddleware first — its timer brackets the entire
    //      request (P0.7), including request/tenant context setup.
    //   2. RequestContextMiddleware next so request_id is available to
    //      the durable-audit path in TenantContextMiddleware (e.g. a JWT
    //      verification failure that still wants to audit the request_id
    //      of the rejected call).
    consumer
      .apply(MetricsMiddleware, RequestContextMiddleware, TenantContextMiddleware)
      .forRoutes("*");
  }
}
