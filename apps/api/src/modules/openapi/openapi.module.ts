import { Module } from "@nestjs/common";
import { OpenApiService } from "./openapi.service";
import { OpenApiController } from "./openapi.controller";

/**
 * OpenAPI document module (P1.10 / ADR-0028).
 *
 * The module is always imported; what's gated is whether `main.ts` actually
 * builds + sets the document (only when `OPENAPI_ENABLED`). The service is
 * exported so `main.ts` can stash the document into it via `app.get(...)`.
 * `AuthorizeGuard` is provided by the global `RbacModule`.
 */
@Module({
  controllers: [OpenApiController],
  providers: [OpenApiService],
  exports: [OpenApiService],
})
export class OpenApiModule {}
