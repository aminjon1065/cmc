import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type {
  Document,
  DocumentResponse,
  DownloadUrlResponse,
  FinalizeUploadResponse,
  ListDocumentsResponse,
  MultipartInitResponse,
  UploadInitResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { DocumentsService } from "./documents.service";
import { UploadInitDto } from "./dto/upload-init.dto";
import { MultipartCompleteDto } from "./dto/multipart-complete.dto";

type DocumentRow = {
  id: string;
  name: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number | null;
  status: string;
  uploadedBy: string;
  metadata: unknown;
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Controller("documents")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @Authorize("document:read")
  async list(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<ListDocumentsResponse> {
    const result = await this.documents.list({
      q: q?.trim() || undefined,
      limit: parsePositiveInt(limit),
      offset: parsePositiveInt(offset),
    });
    return {
      documents: result.items.map(toContract),
      total: result.total,
    };
  }

  @Get(":id")
  @Authorize("document:read")
  async getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.getByIdOrFail(id);
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

  @Delete(":id")
  @Authorize("document:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id", new ParseUUIDPipe()) id: string): Promise<void> {
    await this.documents.softDelete(id);
  }
}
