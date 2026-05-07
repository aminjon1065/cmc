import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

/**
 * Authorisation gate for any endpoint that requires a logged-in user.
 *
 * Trusts `req.tenantContext` set by `TenantContextMiddleware` after a
 * successful JWT verification — the guard itself does not re-validate the
 * token, so verification stays in one place.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenantContext) {
      throw new UnauthorizedException("Authentication required");
    }
    return true;
  }
}
