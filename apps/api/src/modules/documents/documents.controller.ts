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
  UploadInitResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { DocumentsService } from "./documents.service";
import { UploadInitDto } from "./dto/upload-init.dto";

type DocumentRow = {
  id: string;
  name: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number | null;
  status: string;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Controller("documents")
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<ListDocumentsResponse> {
    const result = await this.documents.list({
      q: q?.trim() || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return {
      documents: result.items.map(toContract),
      total: result.total,
    };
  }

  @Get(":id")
  async getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<DocumentResponse> {
    const doc = await this.documents.getByIdOrFail(id);
    return { document: toContract(doc) };
  }

  @Post("upload-init")
  @HttpCode(HttpStatus.CREATED)
  async initUpload(
    @Body() body: UploadInitDto,
  ): Promise<UploadInitResponse> {
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

  @Post(":id/finalize")
  @HttpCode(HttpStatus.OK)
  async finalize(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<FinalizeUploadResponse> {
    const doc = await this.documents.finalize(id);
    return { document: toContract(doc) };
  }

  @Get(":id/download-url")
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

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.documents.softDelete(id);
  }
}
