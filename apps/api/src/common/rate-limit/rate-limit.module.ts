import { Global, Module } from "@nestjs/common";
import { RateLimitService } from "./rate-limit.service";

/**
 * Provides `RateLimitService` globally so any controller can call
 * `enforce(...)` without a per-module `imports` line. The service holds
 * no per-tenant state — Redis owns all state — so a single instance is
 * safe to share across modules.
 *
 * The module is intentionally minimal: today the only consumer is the
 * auth controller (P0.1). When a second consumer arrives (e.g. password
 * reset at P1.3, or document-upload throttle), it just injects the
 * service the same way the auth controller does.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
