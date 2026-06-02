import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { StorageService } from "../storage/storage.service";
import { PREVIEW_QUEUE, type PreviewQueue } from "./preview.queue";

type PreviewKind = "image" | "pdf" | "video" | "audio";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Preview generation (P2.13 / ADR-0043). `enqueue()` is called on finalize
 * (best-effort, never blocks the upload); the BullMQ worker (P2.13b) then calls
 * `generatePreview()`. Image previews use `sharp` (bundled, dynamic-imported);
 * PDF/video/audio need poppler/ffmpeg in the runtime image and are skipped with
 * a log until present.
 */
@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    @Inject(PREVIEW_QUEUE) private readonly queue: PreviewQueue,
    private readonly tenantDb: TenantDatabaseService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Best-effort enqueue — failures are logged, never thrown to the caller. */
  async enqueue(tenantId: string, documentId: string): Promise<void> {
    try {
      await this.queue.enqueue({ tenantId, documentId });
    } catch (err) {
      this.logger.warn(`preview enqueue failed for ${documentId}: ${msg(err)}`);
    }
  }

  /**
   * Generate + store a preview for a ready document, writing the preview key into
   * `documents.metadata.previews`. Returns the key, or null when no preview
   * applies (unknown kind, or a kind whose toolchain isn't installed). Takes the
   * tenant id explicitly — the worker runs outside any request context.
   */
  async generatePreview(
    tenantId: string,
    documentId: string,
  ): Promise<string | null> {
    const doc = await this.tenantDb.runForTenant(tenantId, () =>
      this.loadReadyDoc(documentId),
    );
    if (!doc) return null;

    const kind = this.kindOf(doc.mimeType);
    if (!kind) return null;
    if (kind !== "image") {
      this.logger.log(
        `preview for ${kind} (${documentId}) needs the ${kind} toolchain (poppler/ffmpeg) — skipped`,
      );
      return null;
    }

    const previewKey = `previews/${doc.storageKey}.webp`;
    const src = await this.storage.getObjectBytes({
      bucket: doc.storageBucket,
      key: doc.storageKey,
    });
    const sharp = (await import("sharp")).default;
    const maxDim = this.config.get("PREVIEW_MAX_DIM", { infer: true });
    const webp = await sharp(src)
      .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
      .webp()
      .toBuffer();
    await this.storage.putObject({
      bucket: doc.storageBucket,
      key: previewKey,
      body: webp,
      contentType: "image/webp",
    });

    await this.tenantDb.runForTenant(tenantId, () =>
      this.writePreviewMeta(documentId, kind, previewKey),
    );
    return previewKey;
  }

  // ---------- helpers ----------

  private kindOf(mime: string): PreviewKind | null {
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return null;
  }

  private async loadReadyDoc(id: string) {
    return this.tenantDb.run(async (tx) => {
      const row = (
        await tx
          .select()
          .from(schema.documents)
          .where(
            and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)),
          )
          .limit(1)
      )[0];
      return row && row.status === "ready" ? row : null;
    });
  }

  private async writePreviewMeta(
    id: string,
    kind: PreviewKind,
    key: string,
  ): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.documents)
        .set({
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            previews: { [kind]: key },
          })}::jsonb`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.documents.id, id)),
    );
  }
}
