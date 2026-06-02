import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  Document,
  DocumentResponse,
  DocumentSearchResponse,
  DocumentVersionsListResponse,
  DownloadUrlResponse,
  FinalizeUploadResponse,
  InitVersionResponse,
  ListDocumentsResponse,
  MultipartInitResponse,
  ReindexResponse,
  RetentionSweepResponse,
  UploadInitResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";
import { DocumentsService } from "./documents.service";
import { RetentionService } from "./retention.service";
import { UploadInitDto } from "./dto/upload-init.dto";
import { MultipartCompleteDto } from "./dto/multipart-complete.dto";
import { MoveDocumentDto } from "./dto/move-document.dto";
import { InitVersionDto } from "./dto/init-version.dto";
import { SetRetentionDto } from "./dto/set-retention.dto";
import { SetLegalHoldDto } from "./dto/set-legal-hold.dto";

type DocumentRow = {
  id: string;
  name: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number | null;
  status: string;
  uploadedBy: string;
  metadata: unknown;
  folderId: string | null;
  currentVersionNo: number;
  retentionDays: number | null;
  legalHold: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** The preview kinds present in `documents.metadata.previews` (P2.13). */
function previewKindsOf(metadata: unknown): string[] {
  const previews = (metadata as { previews?: Record<string, string> } | null)
    ?.previews;
  return previews ? Object.keys(previews) : [];
}

// Reject non-numeric / negative / non-integer values from the query string
// rather than letting them flow through `Number()` → `NaN` → `LIMIT NaN`
// (which produces a 500). Service-side clamps the upper bound.
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Accept only a well-formed UUID for the folder filter; a malformed value is
// ignored (rather than reaching the SQL and erroring on the uuid cast).
function parseUuid(raw: string | undefined): string | undefined {
  return raw && UUID_RE.test(raw) ? raw : undefined;
}

function toContract(row: DocumentRow): Document {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    // Cast: the DB allows arbitrary status strings, but the service only
    // ever writes the three values the schema enumerates.
    status: row.status as Document["status"],
    uploadedBy: row.uploadedBy,
    previewKinds: previewKindsOf(row.metadata),
    folderId: row.folderId,
    currentVersionNo: row.currentVersionNo,
    retentionDays: row.retentionDays,
    legalHold: row.legalHold,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Controller("documents")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly retention: RetentionService,
  ) {}

  @Get()
  @Authorize("document:read")
  async list(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("folderId") folderId?: string,
  ): Promise<ListDocumentsResponse> {
    const result = await this.documents.list({
      q: q?.trim() || undefined,
      limit: parsePositiveInt(limit),
      offset: parsePositiveInt(offset),
      folderId: parseUuid(folderId),
    });
    return {
      documents: result.items.map(toContract),
      total: result.total,
    };
  }

  /**
   * OpenSearch-backed document search, post-filtered by folder access (P3.6b).
   * Declared before `:id` so the literal path isn't captured by the UUID route.
   */
  @Get("search")
  @Authorize("document:read")
  async search(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ): Promise<DocumentSearchResponse> {
    const query = q?.trim();
    if (!query) throw new BadRequestException("Query parameter `q` is required.");
    const r = await this.documents.searchDocuments(
      query,
      parsePositiveInt(limit),
    );
    return { documents: r.documents.map(toContract), backend: r.backend };
  }

  @Get(":id")
  @Authorize("document:read")
  async getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.getReadableOrFail(id);
    return { document: toContract(doc) };
  }

  @Post("upload-init")
  @Authorize("document:write")
  @HttpCode(HttpStatus.CREATED)
  async initUpload(@Body() body: UploadInitDto): Promise<UploadInitResponse> {
    const { document, upload } = await this.documents.initUpload({
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      description: body.description ?? null,
      folderId: body.folderId ?? null,
    });
    return {
      document: toContract(document),
      upload: {
        method: "PUT",
        url: upload.url,
        headers: upload.headers,
        expiresAt: upload.expiresAt,
      },
    };
  }

  // ---------- multipart upload (P2.12 / ADR-0042) ----------

  @Post("multipart/init")
  @Authorize("document:write")
  @HttpCode(HttpStatus.CREATED)
  async initMultipart(
    @Body() body: UploadInitDto,
  ): Promise<MultipartInitResponse> {
    const r = await this.documents.initMultipart({
      name: body.name,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      description: body.description ?? null,
      folderId: body.folderId ?? null,
    });
    return {
      document: toContract(r.document),
      uploadId: r.uploadId,
      partSize: r.partSize,
      parts: r.parts,
      expiresAt: r.expiresAt,
    };
  }

  @Post(":id/multipart/complete")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async completeMultipart(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: MultipartCompleteDto,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.completeMultipart(id, body.parts);
    return { document: toContract(doc) };
  }

  @Post(":id/multipart/abort")
  @Authorize("document:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async abortMultipart(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.documents.abortMultipart(id);
  }

  @Post(":id/finalize")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async finalize(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<FinalizeUploadResponse> {
    const doc = await this.documents.finalize(id);
    return { document: toContract(doc) };
  }

  @Get(":id/download-url")
  @Authorize("document:read")
  async downloadUrl(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DownloadUrlResponse> {
    const presigned = await this.documents.signDownload(id);
    return {
      method: "GET",
      url: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  }

  @Get(":id/preview-url")
  @Authorize("document:read")
  async previewUrl(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DownloadUrlResponse> {
    const presigned = await this.documents.signPreviewUrl(id);
    return {
      method: "GET",
      url: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  }

  @Post(":id/move")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async move(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: MoveDocumentDto,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.moveToFolder(id, body.folderId);
    return { document: toContract(doc) };
  }

  // ---------- versions (P3.4 / ADR-0049) ----------

  @Get(":id/versions")
  @Authorize("document:read")
  async listVersions(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DocumentVersionsListResponse> {
    return { versions: await this.documents.listVersions(id) };
  }

  @Post(":id/versions")
  @Authorize("document:write")
  @HttpCode(HttpStatus.CREATED)
  async initVersion(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: InitVersionDto,
  ): Promise<InitVersionResponse> {
    const r = await this.documents.initVersion(id, {
      sizeBytes: body.sizeBytes,
      mimeType: body.mimeType,
    });
    return {
      document: toContract(r.document),
      versionNo: r.versionNo,
      upload: {
        method: "PUT",
        url: r.upload.url,
        headers: r.upload.headers,
        expiresAt: r.upload.expiresAt,
      },
    };
  }

  @Post(":id/versions/finalize")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async finalizeVersion(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.finalizeVersion(id);
    return { document: toContract(doc) };
  }

  @Get(":id/versions/:versionNo/download-url")
  @Authorize("document:read")
  async versionDownloadUrl(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("versionNo", ParseIntPipe) versionNo: number,
  ): Promise<DownloadUrlResponse> {
    const presigned = await this.documents.signVersionDownload(id, versionNo);
    return {
      method: "GET",
      url: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  }

  @Post(":id/versions/:versionNo/restore")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("versionNo", ParseIntPipe) versionNo: number,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.restoreVersion(id, versionNo);
    return { document: toContract(doc) };
  }

  // ---------- retention + legal hold (P3.5 / ADR-0050) ----------

  /** Manual sweep, scoped to the caller's tenant (the cron sweeps all tenants). */
  @Post("retention/sweep")
  @Authorize("document:delete")
  @HttpCode(HttpStatus.OK)
  async sweepRetention(
    @CurrentUser() user: TenantContext,
  ): Promise<RetentionSweepResponse> {
    return { swept: await this.retention.sweep(user.tenantId) };
  }

  @Post(":id/retention")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async setRetention(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SetRetentionDto,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.setRetention(id, body.retentionDays);
    return { document: toContract(doc) };
  }

  @Post(":id/legal-hold")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async setLegalHold(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SetLegalHoldDto,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.setLegalHold(id, body.hold);
    return { document: toContract(doc) };
  }

  // ---------- search reindex (P3.6) ----------

  /** Re-push the tenant's ready documents into the search index (maintenance). */
  @Post("reindex")
  @Authorize("document:write")
  @HttpCode(HttpStatus.OK)
  async reindex(): Promise<ReindexResponse> {
    return this.documents.reindex();
  }

  @Delete(":id")
  @Authorize("document:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", new ParseUUIDPipe()) id: string): Promise<void> {
    await this.documents.softDelete(id);
  }
}
