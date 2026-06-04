import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { DocExtractResult, DocTextResponse } from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { DocumentExtractionService } from "./document-extraction.service";

/**
 * Document text-extraction endpoints (P5.6 / ADR-0072). Shares the `documents`
 * prefix. `POST :id/extract` (`document:write`) runs extraction synchronously
 * (503 when disabled, 404 when the doc isn't ready); `GET :id/text`
 * (`document:read`) reads the stored result. RLS confines both to the tenant.
 */
@Controller("documents")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class DocumentExtractionController {
  constructor(private readonly extraction: DocumentExtractionService) {}

  @Post(":id/extract")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  extract(
    @CurrentUser() user: TenantContext,
    @Param("id") id: string,
  ): Promise<DocExtractResult> {
    return this.extraction.extract(user.tenantId, id);
  }

  @Get(":id/text")
  @Authorize("document:read")
  text(@Param("id") id: string): Promise<DocTextResponse> {
    return this.extraction.status(id);
  }
}
