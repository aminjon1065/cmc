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
import { RagAskRequestSchema, type RagAskResponse } from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { RagService } from "./rag.service";

/**
 * RAG endpoint (P5.4 / ADR-0070). Gated on `llm:use` (same as the LLM gateway);
 * retrieval inside is additionally permission-filtered per the caller, so the
 * answer can only be grounded in sources they may already read. 503 when the LLM
 * gateway is disabled, 429 on the tenant LLM rate limit, 502 on a provider error.
 */
@Controller("rag")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Post("ask")
  @Authorize("llm:use")
  @HttpCode(HttpStatus.OK)
  async ask(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<RagAskResponse> {
    let parsed;
    try {
      parsed = RagAskRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid RAG request — ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      throw err;
    }
    return this.rag.ask(
      { userId: user.userId, tenantId: user.tenantId },
      parsed,
    );
  }
}
