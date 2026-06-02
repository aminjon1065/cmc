import { createHash } from "crypto";
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
import { PreviewService } from "../previews/preview.service";
import { FoldersService } from "../folders/folders.service";
import { FolderAccessService } from "../folders/folder-access.service";

export type ListDocumentsParams = {
  q?: string;
  limit?: number;
  offset?: number;
  folderId?: string;
};

type DocRow = typeof schema.documents.$inferSelect;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly previews: PreviewService,
    private readonly folders: FoldersService,
    private readonly folderAccess: FolderAccessService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Filing into a folder requires write access to it (P3.3b): 400 if the folder
   * is gone, 403 if it's a restricted folder the caller can't write.
   */
  private async assertFolder(folderId: string | null | undefined): Promise<void> {
    if (!folderId) return;
    await this.folderAccess.assertCanFileInto(folderId);
  }

  /** 404 a document whose folder is in a restricted subtree the caller can't read. */
  private async assertDocReadable(folderId: string | null): Promise<void> {
    if (!(await this.folderAccess.canReadDocumentFolder(folderId))) {
      throw new NotFoundException();
    }
  }

  // ---------- upload init ----------

  async initUpload(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    description?: string | null;
    folderId?: string | null;
  }) {
    const ctx = this.tenantContext.requireCurrent();

    const max = this.config.get("DOCUMENTS_MAX_UPLOAD_BYTES", { infer: true });
    if (input.sizeBytes > max) {
      throw new BadRequestException(
        `File exceeds the ${max} byte limit (declared ${input.sizeBytes}).`,
      );
    }
    await this.assertFolder(input.folderId);

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
          folderId: input.folderId ?? null,
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
      contentLength: input.sizeBytes,
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

    // Record v1 (P3.4) + queue a preview — both best-effort, never block finalize.
    await this.recordInitialVersion(updated!);
    await this.previews.enqueue(ctx.tenantId, documentId);
    return updated!;
  }

  // ---------- multipart upload (P2.12 / ADR-0042) ----------

  async initMultipart(input: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    description?: string | null;
    folderId?: string | null;
  }) {
    const ctx = this.tenantContext.requireCurrent();
    const max = this.config.get("DOCUMENTS_MAX_UPLOAD_BYTES", { infer: true });
    if (input.sizeBytes > max) {
      throw new BadRequestException(
        `File exceeds the ${max} byte limit (declared ${input.sizeBytes}).`,
      );
    }
    await this.assertFolder(input.folderId);

    const bucket = this.config.get("S3_BUCKET_FILES", { infer: true });
    const partSize = this.config.get("DOCUMENTS_MULTIPART_PART_SIZE", {
      infer: true,
    });
    const partCount = Math.max(1, Math.ceil(input.sizeBytes / partSize));

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
          storageKey: "pending",
          status: "uploading",
          uploadedBy: ctx.userId,
          folderId: input.folderId ?? null,
        })
        .returning(),
    );
    if (!row) throw new Error("Failed to insert document row");

    const storageKey = this.buildStorageKey(ctx.tenantId, row.id);
    const uploadId = await this.storage.createMultipartUpload({
      bucket,
      key: storageKey,
      contentType: input.mimeType,
    });

    // Persist the storage key + uploadId so complete/abort don't trust the
    // client for the uploadId.
    const [document] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({
          storageKey,
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            multipart: { uploadId, partSize, partCount },
          })}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, row.id))
        .returning(),
    );

    const ttl = this.config.get("DOCUMENTS_UPLOAD_URL_TTL_SEC", { infer: true });
    const parts: Array<{ partNumber: number; url: string }> = [];
    for (let n = 1; n <= partCount; n++) {
      const url = await this.storage.presignUploadPart({
        bucket,
        key: storageKey,
        uploadId,
        partNumber: n,
        ttlSec: ttl,
      });
      parts.push({ partNumber: n, url });
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.multipart_init",
      resourceType: "document",
      resourceId: document!.id,
      outcome: "success",
      metadata: { name: input.name, sizeBytes: input.sizeBytes, partCount },
    });

    return {
      document: document!,
      uploadId,
      partSize,
      parts,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async completeMultipart(
    documentId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ) {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.findById(documentId);
    if (!existing) throw new NotFoundException();
    if (existing.uploadedBy !== ctx.userId) {
      throw new ForbiddenException("Document belongs to another user.");
    }
    if (existing.status === "ready") return existing; // idempotent

    const uploadId = this.multipartUploadId(existing.metadata);
    if (!uploadId) {
      throw new BadRequestException("Not a multipart upload.");
    }

    try {
      await this.storage.completeMultipartUpload({
        bucket: existing.storageBucket,
        key: existing.storageKey,
        uploadId,
        parts,
      });
    } catch (err) {
      this.logger.warn(
        `multipart complete failed for ${documentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.markFailed(documentId, "multipart_complete_failed");
      throw new BadRequestException("Failed to assemble multipart upload.");
    }

    const head = await this.storage.head({
      bucket: existing.storageBucket,
      key: existing.storageKey,
    });
    if (!head.exists) {
      await this.markFailed(documentId, "object_missing");
      throw new BadRequestException("Assembled object missing in storage.");
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
      action: "document.multipart_complete",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { sizeBytes: head.contentLength, parts: parts.length },
    });
    await this.recordInitialVersion(updated!); // v1 (P3.4)
    await this.previews.enqueue(ctx.tenantId, documentId);
    return updated!;
  }

  async abortMultipart(documentId: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.findById(documentId);
    if (!existing) throw new NotFoundException();
    if (existing.uploadedBy !== ctx.userId) {
      throw new ForbiddenException("Document belongs to another user.");
    }

    const uploadId = this.multipartUploadId(existing.metadata);
    if (uploadId) {
      try {
        await this.storage.abortMultipartUpload({
          bucket: existing.storageBucket,
          key: existing.storageKey,
          uploadId,
        });
      } catch (err) {
        this.logger.warn(
          `multipart abort failed for ${documentId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await this.markFailed(documentId, "multipart_aborted");

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.multipart_abort",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
    });
  }

  private multipartUploadId(metadata: unknown): string | null {
    const mp = (metadata as { multipart?: { uploadId?: string } } | null)
      ?.multipart;
    return mp?.uploadId ?? null;
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
    if (params.folderId) {
      filters.push(eq(schema.documents.folderId, params.folderId));
    }
    // Hide documents in restricted subtrees the caller can't read (P3.3b).
    const accessCond = this.folderAccess.documentListCondition(
      await this.folderAccess.resolveContext(),
    );
    if (accessCond) filters.push(accessCond);
    if (params.q) {
      // Escape LIKE wildcards from user input so the search is a literal
      // substring match, not a pattern. `\` itself must be escaped first.
      const escaped = params.q
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      const pattern = `%${escaped}%`;
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

  /** Like getByIdOrFail, but also 404s docs in a restricted folder (P3.3b). */
  async getReadableOrFail(id: string) {
    const doc = await this.getByIdOrFail(id);
    await this.assertDocReadable(doc.folderId);
    return doc;
  }

  /** Re-file a document into `folderId` (null = unfile) (P3.3 / ADR-0047). */
  async moveToFolder(documentId: string, folderId: string | null) {
    const ctx = this.tenantContext.requireCurrent();
    // Must be able to see the document (its current folder) AND write the target.
    await this.getReadableOrFail(documentId);
    await this.assertFolder(folderId);
    const updated = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({ folderId, updatedAt: sql`now()` })
        .where(eq(schema.documents.id, documentId))
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.moved",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { folderId },
    });
    return updated[0]!;
  }

  // ---------- versioning (P3.4 / ADR-0049) ----------

  /** Best-effort SHA-256 hex of an object, or null (over the cap or on error). */
  private async contentHash(
    bucket: string,
    key: string,
    sizeBytes: number | null | undefined,
  ): Promise<string | null> {
    const cap = this.config.get("DOCUMENTS_HASH_MAX_BYTES", { infer: true });
    if (sizeBytes != null && sizeBytes > cap) return null;
    try {
      const bytes = await this.storage.getObjectBytes({ bucket, key });
      if (bytes.length > cap) return null;
      return createHash("sha256").update(bytes).digest("hex");
    } catch (err) {
      this.logger.warn(`content hash failed for ${bucket}/${key}: ${msg(err)}`);
      return null;
    }
  }

  /** Insert v1 for a freshly-ready document (idempotent on the unique index). */
  private async recordInitialVersion(doc: DocRow): Promise<void> {
    try {
      const hash = await this.contentHash(
        doc.storageBucket,
        doc.storageKey,
        doc.sizeBytes,
      );
      await this.tenantDb.run((tx) =>
        tx
          .insert(schema.documentVersions)
          .values({
            tenantId: doc.tenantId,
            documentId: doc.id,
            versionNo: 1,
            storageKey: doc.storageKey,
            sizeBytes: doc.sizeBytes,
            etag: doc.etag,
            contentHash: hash,
            mimeType: doc.mimeType,
            uploadedBy: doc.uploadedBy,
          })
          .onConflictDoNothing(),
      );
    } catch (err) {
      this.logger.warn(`v1 record failed for ${doc.id}: ${msg(err)}`);
    }
  }

  /** Write access to a document's folder, if it's filed (P3.3b). */
  private async assertDocWritable(folderId: string | null): Promise<void> {
    if (folderId) await this.folderAccess.assertCanFileInto(folderId);
  }

  /** Start a new-version upload — returns a presigned PUT to a fresh key. */
  async initVersion(
    documentId: string,
    input: { sizeBytes: number; mimeType?: string },
  ) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
    await this.assertDocWritable(doc.folderId);
    if (doc.status !== "ready") {
      throw new BadRequestException("Document is not ready.");
    }
    const max = this.config.get("DOCUMENTS_MAX_UPLOAD_BYTES", { infer: true });
    if (input.sizeBytes > max) {
      throw new BadRequestException(`File exceeds the ${max} byte limit.`);
    }

    const nextNo = (await this.maxVersionNo(documentId)) + 1;
    const mimeType = input.mimeType ?? doc.mimeType;
    const key = `${this.buildStorageKey(ctx.tenantId, documentId)}/v${nextNo}`;

    const ttl = this.config.get("DOCUMENTS_UPLOAD_URL_TTL_SEC", { infer: true });
    const upload = await this.storage.presignPut({
      bucket: doc.storageBucket,
      key,
      contentType: mimeType,
      contentLength: input.sizeBytes,
      ttlSec: ttl,
    });

    // Stash the pending version in metadata (server-trusted, like multipart).
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            pendingVersion: {
              versionNo: nextNo,
              storageKey: key,
              mimeType,
              sizeBytes: input.sizeBytes,
            },
          })}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, documentId)),
    );

    const document = await this.getByIdOrFail(documentId);
    return { document, versionNo: nextNo, upload };
  }

  /** Finalize the pending version → record it + make it current. */
  async finalizeVersion(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
    await this.assertDocWritable(doc.folderId);

    const pending = (
      doc.metadata as {
        pendingVersion?: {
          versionNo: number;
          storageKey: string;
          mimeType: string;
          sizeBytes: number;
        };
      } | null
    )?.pendingVersion;
    if (!pending) {
      throw new BadRequestException("No pending version to finalize.");
    }

    const head = await this.storage.head({
      bucket: doc.storageBucket,
      key: pending.storageKey,
    });
    if (!head.exists) {
      throw new BadRequestException("Version upload not completed.");
    }

    const hash = await this.contentHash(
      doc.storageBucket,
      pending.storageKey,
      head.contentLength,
    );

    await this.tenantDb.run(async (tx) => {
      await tx.insert(schema.documentVersions).values({
        tenantId: ctx.tenantId,
        documentId,
        versionNo: pending.versionNo,
        storageKey: pending.storageKey,
        sizeBytes: head.contentLength ?? pending.sizeBytes,
        etag: head.etag ?? null,
        contentHash: hash,
        mimeType: pending.mimeType,
        uploadedBy: ctx.userId,
      });
      // Repoint the document at the new version (denormalised) + drop pending.
      await tx
        .update(schema.documents)
        .set({
          currentVersionNo: pending.versionNo,
          storageKey: pending.storageKey,
          etag: head.etag ?? null,
          sizeBytes: head.contentLength ?? pending.sizeBytes,
          mimeType: pending.mimeType,
          metadata: sql`(coalesce(metadata, '{}'::jsonb) - 'pendingVersion')`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, documentId));
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.version_added",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { versionNo: pending.versionNo },
    });
    await this.previews.enqueue(ctx.tenantId, documentId);
    return this.getByIdOrFail(documentId);
  }

  async listVersions(documentId: string) {
    await this.getReadableOrFail(documentId);
    const doc = await this.getByIdOrFail(documentId);
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.documentVersions)
        .where(eq(schema.documentVersions.documentId, documentId))
        .orderBy(desc(schema.documentVersions.versionNo)),
    );
    return rows.map((r) => ({
      versionNo: r.versionNo,
      sizeBytes: r.sizeBytes,
      etag: r.etag,
      contentHash: r.contentHash,
      mimeType: r.mimeType,
      uploadedBy: r.uploadedBy,
      isCurrent: r.versionNo === doc.currentVersionNo,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async signVersionDownload(documentId: string, versionNo: number) {
    const doc = await this.getReadableOrFail(documentId);
    const version = (
      await this.tenantDb.run((tx) =>
        tx
          .select()
          .from(schema.documentVersions)
          .where(
            and(
              eq(schema.documentVersions.documentId, documentId),
              eq(schema.documentVersions.versionNo, versionNo),
            ),
          )
          .limit(1),
      )
    )[0];
    if (!version) throw new NotFoundException("Version not found.");

    const ttl = this.config.get("DOCUMENTS_DOWNLOAD_URL_TTL_SEC", {
      infer: true,
    });
    return this.storage.presignGet({
      bucket: doc.storageBucket,
      key: version.storageKey,
      downloadFilename: `${doc.name}.v${versionNo}`,
      contentType: version.mimeType,
      ttlSec: ttl,
    });
  }

  /** Make an existing version current again (rollback) — repoints, no new bytes. */
  async restoreVersion(documentId: string, versionNo: number) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
    await this.assertDocWritable(doc.folderId);
    const version = (
      await this.tenantDb.run((tx) =>
        tx
          .select()
          .from(schema.documentVersions)
          .where(
            and(
              eq(schema.documentVersions.documentId, documentId),
              eq(schema.documentVersions.versionNo, versionNo),
            ),
          )
          .limit(1),
      )
    )[0];
    if (!version) throw new NotFoundException("Version not found.");

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({
          currentVersionNo: version.versionNo,
          storageKey: version.storageKey,
          etag: version.etag,
          sizeBytes: version.sizeBytes,
          mimeType: version.mimeType,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, documentId)),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.version_restored",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { versionNo },
    });
    return this.getByIdOrFail(documentId);
  }

  private async maxVersionNo(documentId: string): Promise<number> {
    const row = (
      await this.tenantDb.run((tx) =>
        tx
          .select({ max: sql<number>`coalesce(max(version_no), 0)::int` })
          .from(schema.documentVersions)
          .where(eq(schema.documentVersions.documentId, documentId)),
      )
    )[0];
    return row?.max ?? 0;
  }

  // ---------- download ----------

  async signDownload(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
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

  /** Pre-signed GET for a document's image preview (P2.13). 404 if none. */
  async signPreviewUrl(documentId: string) {
    const doc = await this.getReadableOrFail(documentId);
    const previews =
      (doc.metadata as { previews?: Record<string, string> } | null)
        ?.previews ?? {};
    const key = previews.image;
    if (!key) {
      throw new NotFoundException("No preview available for this document.");
    }
    const ttl = this.config.get("DOCUMENTS_DOWNLOAD_URL_TTL_SEC", {
      infer: true,
    });
    return this.storage.presignGet({
      bucket: doc.storageBucket,
      key,
      contentType: "image/webp",
      ttlSec: ttl,
    });
  }

  // ---------- delete ----------

  async softDelete(documentId: string) {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.getReadableOrFail(documentId);
    if (existing.legalHold) {
      throw new ForbiddenException(
        "Document is under legal hold and cannot be deleted.",
      );
    }

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

  // ---------- retention + legal hold (P3.5 / ADR-0050) ----------

  /** Set/clear a document's retention override (null = inherit folder policy). */
  async setRetention(documentId: string, retentionDays: number | null) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
    await this.assertDocWritable(doc.folderId);
    const [updated] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({ retentionDays, updatedAt: sql`now()` })
        .where(eq(schema.documents.id, documentId))
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "document.retention_set",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
      metadata: { retentionDays },
    });
    return updated!;
  }

  /** Place / lift a legal hold (suspends retention + manual deletion). */
  async setLegalHold(documentId: string, hold: boolean) {
    const ctx = this.tenantContext.requireCurrent();
    const doc = await this.getReadableOrFail(documentId);
    await this.assertDocWritable(doc.folderId);
    const [updated] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({ legalHold: hold, updatedAt: sql`now()` })
        .where(eq(schema.documents.id, documentId))
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: hold ? "document.legal_hold_set" : "document.legal_hold_cleared",
      resourceType: "document",
      resourceId: documentId,
      outcome: "success",
    });
    return updated!;
  }

  // ---------- internal ----------

  private async markFailed(id: string, reason: string) {
    // The caller throws right after this returns, which rolls back the
    // request transaction. The status update has to survive that rollback,
    // so write it through a fresh autonomous transaction.
    //
    // Defense in depth: this path bypasses RLS, so we add an explicit
    // tenant_id predicate using the current context — a bug elsewhere
    // cannot trick this into mutating another tenant's row.
    const ctx = this.tenantContext.requireCurrent();
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
        .where(
          and(
            eq(schema.documents.id, id),
            eq(schema.documents.tenantId, ctx.tenantId),
          ),
        ),
    );
  }

  private buildStorageKey(tenantId: string, documentId: string): string {
    return `tenants/${tenantId}/documents/${documentId}`;
  }
}

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
