import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";

export type ListDocumentsParams = {
  q?: string;
  limit?: number;
  offset?: number;
};

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------- upload init ----------

  async initUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    description?: string | null;
  }) {
    const ctx = this.tenantContext.requireCurrent();

    const max = this.config.get("DOCUMENTS_MAX_UPLOAD_BYTES", { infer: true });
    if (input.sizeBytes > max) {
      throw new BadRequestException(
        `File exceeds the ${max} byte limit (declared ${input.sizeBytes}).`,
      );
    }

    const bucket = this.config.get("S3_BUCKET_FILES", { infer: true });

    // Insert the metadata row first so we have a stable id to embed in
    // the storage key. Status starts as 'uploading'; finalize flips it.
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.documents)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          storageBucket: bucket,
          // Provisional key — overwritten right below to embed the row id.
          storageKey: "pending",
          status: "uploading",
          uploadedBy: ctx.userId,
        })
        .returning(),
    );
    if (!row) throw new Error("Failed to insert document row");

    const storageKey = this.buildStorageKey(ctx.tenantId, row.id);
    const updated = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({ storageKey, updatedAt: sql`now()` })
        .where(eq(schema.documents.id, row.id))
        .returning(),
    );
    const document = updated[0]!;

    const ttl = this.config.get("DOCUMENTS_UPLOAD_URL_TTL_SEC", {
      infer: true,
    });
    const upload = await this.storage.presignPut({
      bucket,
      key: storageKey,
      contentType: input.mimeType,
      ttlSec: ttl,
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.upload_init",
      resourceType: "document",
      resourceId: document.id,
      outcome: "success",
      metadata: {
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
    });

    return { document, upload };
  }

  // ---------- finalize ----------

  async finalize(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.findById(documentId);
    if (!existing) throw new NotFoundException();
    if (existing.uploadedBy !== ctx.userId) {
      // Concurrent uploads from different users in the same tenant
      // shouldn't share each other's pending rows.
      throw new ForbiddenException("Document belongs to another user.");
    }
    if (existing.status === "ready") {
      // Idempotent: re-finalize is a no-op success.
      return existing;
    }

    const head = await this.storage.head({
      bucket: existing.storageBucket,
      key: existing.storageKey,
    });

    if (!head.exists) {
      await this.markFailed(documentId, "object_missing");
      throw new BadRequestException(
        "Upload was not completed — object missing in storage.",
      );
    }

    if (
      existing.sizeBytes != null &&
      head.contentLength != null &&
      head.contentLength !== existing.sizeBytes
    ) {
      await this.markFailed(documentId, "size_mismatch");
      throw new BadRequestException(
        `Uploaded size ${head.contentLength} doesn't match declared ${existing.sizeBytes}.`,
      );
    }

    const [updated] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({
          status: "ready",
          etag: head.etag ?? null,
          sizeBytes: head.contentLength ?? existing.sizeBytes,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, documentId))
        .returning(),
    );

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.finalize",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { sizeBytes: head.contentLength, etag: head.etag },
    });

    return updated!;
  }

  // ---------- list / get ----------

  async list(params: ListDocumentsParams) {
    const ctx = this.tenantContext.requireCurrent();
    const limit = clamp(params.limit ?? 50, 1, 200);
    const offset = Math.max(params.offset ?? 0, 0);

    const filters = [
      isNull(schema.documents.deletedAt),
      eq(schema.documents.status, "ready"),
    ];
    if (params.q) {
      const pattern = `%${params.q}%`;
      filters.push(
        or(
          ilike(schema.documents.name, pattern),
          ilike(schema.documents.description, pattern),
        )!,
      );
    }

    const where = and(...filters);

    const [items, totalRow] = await this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.documents)
        .where(where)
        .orderBy(desc(schema.documents.createdAt), asc(schema.documents.id))
        .limit(limit)
        .offset(offset);
      const totalRows = await tx
        .select({ value: count() })
        .from(schema.documents)
        .where(where);
      return [rows, totalRows[0]];
    });

    return {
      items,
      total: totalRow?.value ?? 0,
      tenantId: ctx.tenantId,
    };
  }

  async findById(id: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.documents)
        .where(
          and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async getByIdOrFail(id: string) {
    const doc = await this.findById(id);
    if (!doc) throw new NotFoundException();
    return doc;
  }

  // ---------- download ----------

  async signDownload(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getByIdOrFail(documentId);
    if (doc.status !== "ready") {
      throw new BadRequestException("Document is not ready for download.");
    }

    const ttl = this.config.get("DOCUMENTS_DOWNLOAD_URL_TTL_SEC", {
      infer: true,
    });
    const presigned = await this.storage.presignGet({
      bucket: doc.storageBucket,
      key: doc.storageKey,
      downloadFilename: doc.name,
      contentType: doc.mimeType,
      ttlSec: ttl,
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.download",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
    });

    return presigned;
  }

  // ---------- delete ----------

  async softDelete(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.getByIdOrFail(documentId);

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.documents.id, documentId)),
    );

    // Best-effort delete the underlying object too. If the bucket call
    // fails the row is already soft-deleted; a future janitor sweeps
    // orphaned objects (not implemented yet).
    try {
      await this.storage.delete({
        bucket: existing.storageBucket,
        key: existing.storageKey,
      });
    } catch (err) {
      this.logger.warn(
        `Object delete failed for ${existing.storageBucket}/${existing.storageKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.delete",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { name: existing.name },
    });
  }

  // ---------- internal ----------

  private async markFailed(id: string, reason: string) {
    // The caller throws right after this returns, which rolls back the
    // request transaction. The status update has to survive that rollback,
    // so write it through a fresh autonomous transaction.
    await this.tenantDb.runPrivileged((privTx) =>
      privTx
        .update(schema.documents)
        .set({
          status: "failed",
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            failureReason: reason,
          })}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, id)),
    );
  }

  private buildStorageKey(tenantId: string, documentId: string): string {
    return `tenants/${tenantId}/documents/${documentId}`;
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
