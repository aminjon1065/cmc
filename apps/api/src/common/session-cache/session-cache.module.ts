import { Global, Module } from "@nestjs/common";
import { SessionCacheService } from "./session-cache.service";

/**
 * Provides `SessionCacheService` globally so the middleware (in
 * `common/`) and `SessionsService` (in `modules/auth/`) can both
 * inject it without circular module imports.
 *
 * Mirrors `RateLimitModule` — the cache holds no per-tenant or
 * per-request state of its own; Redis owns everything.
 */
@Global()
@Module({
  providers: [SessionCacheService],
  exports: [SessionCacheService],
})
export class SessionCacheModule {}
