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
  type IncidentAssigneesResponse,
  type IncidentDetailResponse,
  type IncidentStatsResponse,
  type IncidentsListResponse,
  RESOLVING_STATUSES,
} from "@cmc/contracts";
import { IncidentsService } from "./incidents.service";
import { RbacService } from "../rbac/rbac.service";
import { CreateIncidentDto } from "./dto/create-incident.dto";
import { UpdateIncidentDto } from "./dto/update-incident.dto";
import { TransitionIncidentDto } from "./dto/transition-incident.dto";
import { AssignIncidentDto } from "./dto/assign-incident.dto";
import { ListIncidentsQuery } from "./dto/list-incidents.query";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * Incident endpoints (P1.5 / ADR-0023). Every route is `@Authorize`-gated on a
 * specific `incident:*` permission; RLS confines all data to the caller's
 * tenant (cross-tenant id → 404). The transition route is gated on
 * `incident:write` but additionally requires `incident:resolve` when the target
 * is a resolving status (resolved/closed) — enforced inline below.
 */
@Controller("incidents")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class IncidentsController {
  constructor(
    private readonly incidents: IncidentsService,
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
  @Authorize("incident:create")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreateIncidentDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<IncidentDetailResponse> {
    const incident = await this.incidents.create(body, this.actor(user, ip, req));
    return { incident };
  }

  @Get()
  @Authorize("incident:read")
  async list(
    @Query() query: ListIncidentsQuery,
  ): Promise<IncidentsListResponse> {
    return this.incidents.list(query);
  }

  /** Active-incident aggregates for the dashboard. Declared BEFORE `:id` so
   *  "stats" isn't captured by the UUID param route. */
  @Get("stats")
  @Authorize("incident:read")
  async stats(): Promise<IncidentStatsResponse> {
    return this.incidents.stats();
  }

  /** Assignable tenant members (for the assign UI). Before `:id` for the same
   *  reason as stats. Gated on incident:assign — only assigners need it. */
  @Get("assignees")
  @Authorize("incident:assign")
  async assignees(): Promise<IncidentAssigneesResponse> {
    return { assignees: await this.incidents.listAssignees() };
  }

  @Get(":id")
  @Authorize("incident:read")
  async detail(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<IncidentDetailResponse> {
    const incident = await this.incidents.getDetail(id);
    if (!incident) throw new NotFoundException("Incident not found");
    return { incident };
  }

  @Patch(":id")
  @Authorize("incident:write")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateIncidentDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<IncidentDetailResponse> {
    if (Object.keys(body).length === 0) {
      throw new BadRequestException("Provide at least one field to update");
    }
    const incident = await this.incidents.update(
      id,
      body,
      this.actor(user, ip, req),
    );
    return { incident };
  }

  @Post(":id/transition")
  @Authorize("incident:write")
  @HttpCode(HttpStatus.OK)
  async transition(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: TransitionIncidentDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<IncidentDetailResponse> {
    // Resolving/closing needs the stronger `incident:resolve` on top of write.
    if (RESOLVING_STATUSES.includes(body.to)) {
      await this.rbac.enforce(["incident:resolve"]);
    }
    const incident = await this.incidents.transition(
      id,
      body.to,
      { note: body.note },
      this.actor(user, ip, req),
    );
    return { incident };
  }

  @Post(":id/assign")
  @Authorize("incident:assign")
  @HttpCode(HttpStatus.OK)
  async assign(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: AssignIncidentDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<IncidentDetailResponse> {
    const incident = await this.incidents.assign(
      id,
      body.userId,
      this.actor(user, ip, req),
    );
    return { incident };
  }

  @Delete(":id")
  @Authorize("incident:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.incidents.softDelete(id, this.actor(user, ip, req));
  }
}
