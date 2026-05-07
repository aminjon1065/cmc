import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response, NextFunction } from "express";
import type { JwtClaims } from "@cmc/contracts";
import {
  TenantContextService,
  type TenantContext,
} from "./tenant-context.service";

/**
 * Validates the Authorization Bearer JWT (if present), extracts the
 * tenant/user, and:
 *   1. attaches it to `req.tenantContext` (used by @CurrentUser),
 *   2. wraps the rest of the request handling inside an ALS scope so
 *      downstream services can read the same context without parameters.
 *
 * Anonymous requests (no header, or invalid token) pass through with no
 * context — protected routes are rejected later by `JwtAuthGuard`.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly tenantContext: TenantContextService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return next();
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return next();
    }

    let claims: JwtClaims;
    try {
      claims = this.jwt.verify<JwtClaims>(token);
    } catch (err) {
      // Invalid or expired token. Don't reject here — let the route's guard
      // decide whether auth is required. Public endpoints (e.g. /health)
      // remain accessible.
      this.logger.debug(
        `Discarding invalid bearer token on ${req.method} ${req.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return next();
    }

    const context: TenantContext = {
      userId: claims.sub,
      tenantId: claims.tid,
      tenantSlug: claims.ts,
      email: claims.email,
    };

    req.tenantContext = context;
    this.tenantContext.run(context, () => next());
  }
}
