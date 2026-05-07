import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { TenantContext } from "../tenant-context/tenant-context.service";

/**
 * Inject the current authenticated user/tenant into a controller method.
 *
 *   @Get("me")
 *   me(@CurrentUser() user: TenantContext) { ... }
 *
 *   @Get("me/email")
 *   email(@CurrentUser("email") email: string) { ... }
 *
 * Must be used on a route protected by `JwtAuthGuard` — it throws if no
 * tenant context is attached to the request.
 */
export const CurrentUser = createParamDecorator(
  (
    field: keyof TenantContext | undefined,
    ctx: ExecutionContext,
  ): TenantContext | TenantContext[keyof TenantContext] => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tc = req.tenantContext;
    if (!tc) {
      throw new UnauthorizedException("Authentication required");
    }
    return field ? tc[field] : tc;
  },
);
