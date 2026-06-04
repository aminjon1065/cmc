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
  LlmCompleteRequestSchema,
  type LlmCompleteResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { LlmService } from "./llm.service";

/**
 * LLM gateway endpoint (P5.1 / ADR-0067). Gated on `llm:use`; per-tenant
 * rate-limited + audited in the service. 503 when the gateway is disabled, 429
 * when the tenant exceeds its minute budget, 502 on a provider error.
 */
@Controller("llm")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Post("complete")
  @Authorize("llm:use")
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<LlmCompleteResponse> {
    let parsed;
    try {
      parsed = LlmCompleteRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid LLM request — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return this.llm.complete(
      { userId: user.userId, tenantId: user.tenantId },
      parsed,
    );
  }
}
