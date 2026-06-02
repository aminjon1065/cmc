import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  ValidateWorkflowResponse,
  WorkflowResponse,
  WorkflowRunResponse,
  WorkflowRunsListResponse,
  WorkflowsListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";

import { WorkflowsService } from "./workflows.service";

/**
 * Workflow definition endpoints (P3.8a / ADR-0053). `@Authorize`-gated on
 * `workflow:*`; RLS confines all rows to the caller's tenant (cross-tenant id →
 * 404). Bodies are Zod-parsed in the service (the definition is a deep
 * discriminated union — class-validator would be unwieldy).
 */
@Controller("workflows")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  @Authorize("workflow:read")
  async list(): Promise<WorkflowsListResponse> {
    return { workflows: await this.workflows.list() };
  }

  @Post()
  @Authorize("workflow:write")
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WorkflowResponse> {
    return { workflow: await this.workflows.create(body) };
  }

  /** Validate a definition without saving (declared before `:id`). */
  @Post("validate")
  @Authorize("workflow:write")
  @HttpCode(HttpStatus.OK)
  validate(@Body() body: unknown): ValidateWorkflowResponse {
    return this.workflows.validate(body);
  }

  /** A single run's status (declared before `:id` so it isn't captured). */
  @Get("runs/:runId")
  @Authorize("workflow:read")
  async getRun(
    @Param("runId", ParseUUIDPipe) runId: string,
  ): Promise<WorkflowRunResponse> {
    return { run: await this.workflows.getRun(runId) };
  }

  @Get(":id")
  @Authorize("workflow:read")
  async getOne(@Param("id", ParseUUIDPipe) id: string): Promise<WorkflowResponse> {
    return { workflow: await this.workflows.get(id) };
  }

  @Get(":id/runs")
  @Authorize("workflow:read")
  async listRuns(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WorkflowRunsListResponse> {
    return { runs: await this.workflows.listRuns(id) };
  }

  @Post(":id/run")
  @Authorize("workflow:run")
  @HttpCode(HttpStatus.ACCEPTED)
  async run(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WorkflowRunResponse> {
    return { run: await this.workflows.run(id, body) };
  }

  @Patch(":id")
  @Authorize("workflow:write")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WorkflowResponse> {
    return { workflow: await this.workflows.update(id, body) };
  }

  @Delete(":id")
  @Authorize("workflow:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.workflows.remove(id);
  }
}
