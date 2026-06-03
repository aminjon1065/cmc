import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  CollabTicketRequestSchema,
  type CollabTicketResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { CollabService } from "./collab.service";

/**
 * Collaboration endpoints (P4.1b / ADR-0060). The browser never holds the
 * access JWT (BFF posture); to open the Hocuspocus WS it first POSTs here
 * (session-authed via the BFF) for a short-lived, single-use ticket. `wiki:write`
 * is enforced at the guard *and* re-checked in the service against the specific
 * page (→ 404 cross-tenant, 403 no-perm).
 */
@Controller("collab")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class CollabController {
  constructor(private readonly collab: CollabService) {}

  @Post("ticket")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.CREATED)
  async ticket(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<CollabTicketResponse> {
    let pageId: string;
    try {
      pageId = CollabTicketRequestSchema.parse(body).pageId;
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid collab ticket request — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return this.collab.issueTicket(
      { userId: user.userId, tenantId: user.tenantId, email: user.email },
      pageId,
    );
  }
}
