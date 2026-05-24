import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import type { RateLimitSpec } from "../../common/rate-limit/rate-limit.service";

/**
 * Factory for the auth-endpoint rate-limit specs.
 *
 * Key shape (per `redis-keys.ts`):
 *   cmc:auth:rate-limit:login:ip:<ip>
 *   cmc:auth:rate-limit:login:email:<sha256(lowercased-email)>
 *   cmc:auth:rate-limit:refresh:ip:<ip>
 *
 * Email is hashed so plaintext PII never lands in `KEYS` output,
 * `MONITOR` traces, or RDB dumps. Lowercased before hashing to match
 * how the login service normalises emails downstream.
 *
 * The factory reads ConfigService on every call so an env reload
 * (out of scope for P0.1 but possible in future) flows through without
 * touching the auth controller.
 */
@Injectable()
export class AuthRateLimitSpecs {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  loginSpecs(input: {
    ip: string | null;
    email: string;
    userAgent?: string | null;
  }): RateLimitSpec[] {
    const auditCommon = {
      action: "user.login",
      resourceType: "user",
      ip: input.ip,
      userAgent: input.userAgent ?? null,
      // Email goes into metadata to mirror the existing failure-audit
      // shape in `auth.service.ts` (`metadata.email`), so investigators
      // can pivot on either denial source uniformly.
      metadata: { email: input.email },
    };
    return [
      {
        name: "auth-login-ip",
        keyDescriptor: "ip",
        limit: this.config.get("AUTH_LOGIN_IP_LIMIT", { infer: true }),
        windowSec: this.config.get("AUTH_LOGIN_IP_WINDOW_SEC", { infer: true }),
        redisKey: input.ip
          ? `cmc:auth:rate-limit:login:ip:${input.ip}`
          : null,
        audit: auditCommon,
      },
      {
        name: "auth-login-email",
        keyDescriptor: "email",
        limit: this.config.get("AUTH_LOGIN_EMAIL_LIMIT", { infer: true }),
        windowSec: this.config.get("AUTH_LOGIN_EMAIL_WINDOW_SEC", {
          infer: true,
        }),
        redisKey: input.email
          ? `cmc:auth:rate-limit:login:email:${hashEmail(input.email)}`
          : null,
        audit: auditCommon,
      },
    ];
  }

  refreshSpecs(input: {
    ip: string | null;
    userAgent?: string | null;
  }): RateLimitSpec[] {
    return [
      {
        name: "auth-refresh-ip",
        keyDescriptor: "ip",
        limit: this.config.get("AUTH_REFRESH_IP_LIMIT", { infer: true }),
        windowSec: this.config.get("AUTH_REFRESH_IP_WINDOW_SEC", {
          infer: true,
        }),
        redisKey: input.ip
          ? `cmc:auth:rate-limit:refresh:ip:${input.ip}`
          : null,
        audit: {
          action: "auth.refresh",
          resourceType: "session",
          ip: input.ip,
          userAgent: input.userAgent ?? null,
        },
      },
    ];
  }
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
