import {
  Controller,
  Get,
  NotFoundException,
  UseGuards,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import { OpenApiService } from "./openapi.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";

/**
 * Serves the generated OpenAPI document at `GET /v1/openapi.json` (P1.10 /
 * ADR-0028).
 *
 * The spec describes the platform's **entire admin surface**, so it is NOT
 * anonymous: it is gated behind a valid session (`JwtAuthGuard`) holding the
 * `tenant:manage` permission (`AuthorizeGuard`) — the same gate the tenant
 * admin endpoints use. The rendered Swagger UI lives in the web admin panel
 * (P1.10b), which fetches this endpoint through the BFF (bearer attached
 * server-side).
 *
 * `@ApiExcludeController` keeps this meta-endpoint out of the document it
 * serves — the doc describes the API, not the doc route itself.
 */
@ApiExcludeController()
@Controller("openapi.json")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class OpenApiController {
  constructor(private readonly openapi: OpenApiService) {}

  @Get()
  @Authorize("tenant:manage")
  getDocument(): OpenAPIObject {
    const document = this.openapi.getDocument();
    if (!document) {
      // OPENAPI_ENABLED=false (or pre-boot) → no document was built.
      throw new NotFoundException("OpenAPI document is not available");
    }
    return document;
  }
}
