import { Global, Module } from "@nestjs/common";
import { RequestContextService } from "./request-context.service";

/**
 * Provides `RequestContextService` globally. The middleware
 * (`RequestContextMiddleware`) is applied from `AppModule` so it
 * fires for every route in a controlled order (must precede
 * `TenantContextMiddleware`).
 *
 * `@Global()` because the service is read by audit, the HTTP
 * exception filter, future OTEL plumbing — all cross-cutting.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule {}
