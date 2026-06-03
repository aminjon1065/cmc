import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodError, type ZodSchema } from "zod";
import {
  CreateImportRequestSchema,
  ImportUploadInitRequestSchema,
  type ImportJobResponse,
  type ImportJobsListResponse,
  type ImportRowErrorsListResponse,
  type ImportUploadInitResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { ImportService } from "./import.service";

function parse<T>(s: ZodSchema<T>, raw: unknown): T {
  try {
    return s.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        `Invalid import payload — ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    throw err;
  }
}

/**
 * Bulk import endpoints (P3.11 / ADR-0056). Creating an import requires
 * `import:run` (plus the target-domain write perm, enforced in the service);
 * viewing jobs + quarantined rows requires `import:read`. RLS confines all rows
 * to the tenant.
 */
@Controller("imports")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  @Post("upload-init")
  @Authorize("import:run")
  @HttpCode(HttpStatus.CREATED)
  async uploadInit(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<ImportUploadInitResponse> {
    const input = parse(ImportUploadInitRequestSchema, body);
    return this.imports.initUpload(input, {
      tenantId: user.tenantId,
      userId: user.userId,
    });
  }

  @Post()
  @Authorize("import:run")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: TenantContext,
    @Body() body: unknown,
  ): Promise<ImportJobResponse> {
    const input = parse(CreateImportRequestSchema, body);
    return {
      job: await this.imports.create(input, {
        tenantId: user.tenantId,
        userId: user.userId,
      }),
    };
  }

  @Get()
  @Authorize("import:read")
  async list(): Promise<ImportJobsListResponse> {
    return { jobs: await this.imports.list() };
  }

  @Get(":id")
  @Authorize("import:read")
  async get(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ImportJobResponse> {
    return { job: await this.imports.get(id) };
  }

  @Get(":id/errors")
  @Authorize("import:read")
  async errors(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<ImportRowErrorsListResponse> {
    return { errors: await this.imports.listErrors(id) };
  }
}
