import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  CASE_RESOLVING_STATUSES,
  type CaseActivitiesResponse,
  type CaseActivityResponse,
  type CaseDetailResponse,
  type CaseStatsResponse,
  type CasesListResponse,
} from "@cmc/contracts";
import { CasesService } from "./cases.service";
import { RbacService } from "../rbac/rbac.service";
import { CreateCaseDto } from "./dto/create-case.dto";
import { UpdateCaseDto } from "./dto/update-case.dto";
import { TransitionCaseDto } from "./dto/transition-case.dto";
import { AssignCaseDto } from "./dto/assign-case.dto";
import { CommentCaseDto } from "./dto/comment-case.dto";
import { ListCasesQuery } from "./dto/list-cases.query";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Case endpoints (P2.10 / ADR-0040). Every route is `@Authorize`-gated on a
 * `case:*` permission; RLS confines all data to the caller's tenant
 * (cross-tenant id → 404). Resolving/closing additionally requires
 * `case:resolve` on top of `case:write` (enforced inline, like incidents).
 */
@Controller("cases")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly rbac: RbacService,
  ) {}

  private actor(user: TenantContext, ip: string, req: Request) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    };
  }

  @Post()
  @Authorize("case:create")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateCaseDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<CaseDetailResponse> {
    return { case: await this.cases.create(body, this.actor(user, ip, req)) };
  }

  @Get()
  @Authorize("case:read")
  list(@Query() query: ListCasesQuery): Promise<CasesListResponse> {
    return this.cases.list(query);
  }

  /** Aggregates for the dashboard. Before `:id` so "stats" isn't a UUID param. */
  @Get("stats")
  @Authorize("case:read")
  stats(): Promise<CaseStatsResponse> {
    return this.cases.stats();
  }

  @Get(":id")
  @Authorize("case:read")
  async detail(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CaseDetailResponse> {
    const found = await this.cases.getDetail(id);
    if (!found) throw new NotFoundException("Case not found");
    return { case: found };
  }

  @Get(":id/activity")
  @Authorize("case:read")
  activity(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<CaseActivitiesResponse> {
    return this.cases.listActivity(id);
  }

  @Patch(":id")
  @Authorize("case:write")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateCaseDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<CaseDetailResponse> {
    if (Object.keys(body).length === 0) {
      throw new BadRequestException("Provide at least one field to update");
    }
    return {
      case: await this.cases.update(id, body, this.actor(user, ip, req)),
    };
  }

  @Post(":id/transition")
  @Authorize("case:write")
  @HttpCode(HttpStatus.OK)
  async transition(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: TransitionCaseDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<CaseDetailResponse> {
    if (CASE_RESOLVING_STATUSES.includes(body.to)) {
      await this.rbac.enforce(["case:resolve"]);
    }
    return {
      case: await this.cases.transition(
        id,
        body.to,
        { note: body.note },
        this.actor(user, ip, req),
      ),
    };
  }

  @Post(":id/assign")
  @Authorize("case:assign")
  @HttpCode(HttpStatus.OK)
  async assign(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AssignCaseDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<CaseDetailResponse> {
    return {
      case: await this.cases.assign(id, body.userId, this.actor(user, ip, req)),
    };
  }

  @Post(":id/comment")
  @Authorize("case:write")
  @HttpCode(HttpStatus.CREATED)
  comment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CommentCaseDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<CaseActivityResponse> {
    return this.cases.addComment(id, body, this.actor(user, ip, req));
  }

  @Delete(":id")
  @Authorize("case:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.cases.softDelete(id, this.actor(user, ip, req));
  }
}
