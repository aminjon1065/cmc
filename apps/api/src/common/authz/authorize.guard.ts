import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Permission } from "@cmc/contracts";
import { AUTHORIZE_KEY } from "./authorize.decorator";
import { RbacService } from "../../modules/rbac/rbac.service";
import { TenantContextService } from "../tenant-context/tenant-context.service";

/**
 * Permission guard for `@Authorize(...)` (P1.1 / ADR-0019).
 *
 * Resolution:
 *   1. No `@Authorize` metadata on the handler/class → not permission-gated,
 *      pass. (Endpoints without it keep whatever JwtAuthGuard / public posture
 *      they already had.)
 *   2. `@Authorize(...)` present but no tenant context → 401 (the request
 *      isn't authenticated; nothing to check against).
 *   3. Otherwise → RbacService.enforce throws 403 + durable denied-audit on
 *      the first missing permission.
 *
 * Reads both handler- and class-level metadata so `@Authorize` can decorate a
 * whole controller.
 */
@Injectable()
export class AuthorizeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      AUTHORIZE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    // Not permission-gated.
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenantContext) {
      throw new UnauthorizedException("Authentication required");
    }

    // enforce() reads the active tenant context (set by middleware) and
    // throws ForbiddenException on the first missing permission.
    await this.rbac.enforce(required);
    return true;
  }
}
