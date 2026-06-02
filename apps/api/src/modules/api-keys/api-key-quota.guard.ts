import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { AppConfig } from "../../config/configuration";
import { RateLimitService } from "../../common/rate-limit/rate-limit.service";

/**
 * Per-key + per-tenant request quota for API-key principals (P3.9a / ADR-0054).
 * Registered as a global guard, but a no-op for interactive (JWT) and anonymous
 * requests — only api-key principals consume the Redis counters. A breach throws
 * `RateLimitExceededError` → the HTTP filter renders 429 + `Retry-After`.
 */
@Injectable()
export class ApiKeyQuotaGuard implements CanActivate {
  private readonly windowSec: number;
  private readonly keyLimit: number;
  private readonly tenantLimit: number;

  constructor(
    private readonly rateLimit: RateLimitService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.windowSec = config.get("API_KEY_RATE_WINDOW_SEC", { infer: true });
    this.keyLimit = config.get("API_KEY_RATE_LIMIT", { infer: true });
    this.tenantLimit = config.get("API_KEY_TENANT_RATE_LIMIT", { infer: true });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tc = req.tenantContext;
    if (tc?.principalType !== "apikey" || !tc.apiKeyId) return true;

    await this.rateLimit.enforce([
      {
        name: "api-key-quota",
        keyDescriptor: "key",
        redisKey: `cmc:apiquota:key:${tc.apiKeyId}`,
        limit: this.keyLimit,
        windowSec: this.windowSec,
        audit: {
          action: "api_key.quota_exceeded",
          resourceType: "api_key",
          tenantId: tc.tenantId,
          actorId: tc.userId,
          metadata: { apiKeyId: tc.apiKeyId, scope: "key" },
        },
      },
      {
        name: "api-key-tenant-quota",
        keyDescriptor: "tenant",
        redisKey: `cmc:apiquota:tenant:${tc.tenantId}`,
        limit: this.tenantLimit,
        windowSec: this.windowSec,
        audit: {
          action: "api_key.quota_exceeded",
          resourceType: "api_key",
          tenantId: tc.tenantId,
          actorId: tc.userId,
          metadata: { apiKeyId: tc.apiKeyId, scope: "tenant" },
        },
      },
    ]);
    return true;
  }
}
