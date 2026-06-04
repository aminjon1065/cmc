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
  CopilotAskRequestSchema,
  type CopilotAskResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { CopilotService } from "./copilot.service";

/**
 * Copilot endpoint (P5.5 / ADR-0071). Unified `POST /v1/copilot/ask` for every
 * module copilot; gated on `llm:use`, with the module's own read permission
 * additionally enforced inside the service (so a copilot can only ground in data
 * the caller may read). 503 when the LLM gateway is disabled, 429 on the tenant
 * LLM rate limit, 502 on a provider error.
 */
@Controller("copilot")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Post("ask")
  @Authorize("llm:use")
  @HttpCode(HttpStatus.OK)
  async ask(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<CopilotAskResponse> {
    let parsed;
    try {
      parsed = CopilotAskRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid copilot request — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return this.copilot.ask(
      { userId: user.userId, tenantId: user.tenantId },
      parsed,
    );
  }
}
