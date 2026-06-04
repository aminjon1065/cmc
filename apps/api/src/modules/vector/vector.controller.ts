import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  VectorReindexResponse,
  VectorStatusResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { VectorIndexService } from "./vector-index.service";

/**
 * Vector pipeline ops (P5.2 / ADR-0068). RLS scopes everything to the tenant.
 * Status needs `document:read`; the (re)embed backfill needs `document:write`.
 */
@Controller("vector")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class VectorController {
  constructor(private readonly vector: VectorIndexService) {}

  @Get("status")
  @Authorize("document:read")
  async status(): Promise<VectorStatusResponse> {
    return this.vector.status();
  }

  @Post("reindex")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async reindex(): Promise<VectorReindexResponse> {
    return { indexed: await this.vector.reindexAll() };
  }
}
