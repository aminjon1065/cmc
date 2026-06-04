import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  DocExtractResult,
  DocTextResponse,
  DocTextStatus,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { StorageService } from "../storage/storage.service";
import { SEARCH_INDEX, type SearchIndex } from "../search/search-index";
import { VectorIndexService } from "../vector/vector-index.service";
import { TEXT_EXTRACTOR, type TextExtractor } from "./text-extractor";
import { EXTRACT_QUEUE, type ExtractQueue } from "./extract.queue";

type ReindexDoc = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  mimeType: string;
  folderId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Document text extraction (P5.6 / ADR-0072). Pulls full text from a `ready`
 * document's bytes (S3) via the gated {@link TextExtractor} (PDF text-layer +
 * Tesseract OCR) and upserts it into `document_text`. Takes the tenant id
 * explicitly + uses `runForTenant` so it works both in-request (the sync
 * endpoint, P5.6a) and from the BullMQ worker (P5.6b, no request context).
 * 503 when extraction is disabled. The OpenSearch/vector re-index hookup is
 * P5.6b.
 */
@Injectable()
export class DocumentExtractionService {
  private readonly logger = new Logger(DocumentExtractionService.name);
  private readonly maxChars: number;
  private readonly ocrLang: string;

  constructor(
    @Inject(TEXT_EXTRACTOR) private readonly extractor: TextExtractor,
    @Inject(EXTRACT_QUEUE) private readonly queue: ExtractQueue,
    @Inject(SEARCH_INDEX) private readonly searchIndex: SearchIndex,
    private readonly vector: VectorIndexService,
    private readonly tenantDb: TenantDatabaseService,
    private readonly storage: StorageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxChars = config.get("DOC_EXTRACT_MAX_CHARS", { infer: true });
    this.ocrLang = config.get("DOC_EXTRACT_OCR_LANG", { infer: true });
  }

  get active(): boolean {
    return this.extractor.active;
  }

  /** Best-effort enqueue (called on document finalize) — never throws. */
  async enqueue(tenantId: string, documentId: string): Promise<void> {
    try {
      await this.queue.enqueue({ tenantId, documentId });
    } catch (err) {
      this.logger.warn(`extract enqueue failed for ${documentId}: ${msg(err)}`);
    }
  }

  /** Extract + store text for a ready document. 503 if disabled, 404 if absent. */
  async extract(tenantId: string, documentId: string): Promise<DocExtractResult> {
    if (!this.extractor.active) {
      throw new ServiceUnavailableException("Document extraction is disabled");
    }
    const doc = await this.tenantDb.runForTenant(tenantId, () =>
      this.loadReadyDoc(documentId),
    );
    if (!doc) throw new NotFoundException("Document not found or not ready");

    const bytes = await this.storage.getObjectBytes({
      bucket: doc.storageBucket,
      key: doc.storageKey,
    });
    const raw = await this.extractor.extract(bytes, doc.mimeType, {
      ocrLang: this.ocrLang,
    });
    const content = raw.slice(0, this.maxChars);
    const status: DocTextStatus = content.length > 0 ? "done" : "empty";

    await this.tenantDb.runForTenant(tenantId, () =>
      this.upsert(tenantId, documentId, content, status),
    );
    // Best-effort: push the new content into OpenSearch + re-embed (P5.2) so the
    // keyword / semantic / RAG / copilot stack becomes content-aware. The text is
    // already persisted — re-index failures never fail the extraction.
    await this.reindex(tenantId, doc, content);
    this.logger.log(
      `extracted ${content.length} chars from ${documentId} (${status})`,
    );
    return { documentId, status, charCount: content.length };
  }

  /** Re-index a freshly-extracted document into OpenSearch + the vector store. */
  private async reindex(
    tenantId: string,
    doc: ReindexDoc,
    content: string,
  ): Promise<void> {
    if (this.searchIndex.active) {
      try {
        await this.searchIndex.indexDocument({
          id: doc.id,
          tenantId,
          name: doc.name,
          description: doc.description,
          mimeType: doc.mimeType,
          folderId: doc.folderId,
          status: doc.status,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
          content,
        });
      } catch (err) {
        this.logger.warn(`opensearch re-index failed for ${doc.id}: ${msg(err)}`);
      }
    }
    try {
      await this.tenantDb.runForTenant(tenantId, () =>
        this.vector.indexDocument({
          id: doc.id,
          tenantId,
          name: doc.name,
          description: doc.description,
          content,
        }),
      );
    } catch (err) {
      this.logger.warn(`vector re-index failed for ${doc.id}: ${msg(err)}`);
    }
  }

  /** Read the stored extracted text + metadata for a document (request-scoped). */
  async status(documentId: string): Promise<DocTextResponse> {
    const row = await this.tenantDb.run(async (tx) =>
      (
        await tx
          .select()
          .from(schema.documentText)
          .where(eq(schema.documentText.documentId, documentId))
          .limit(1)
      ).at(0),
    );
    return {
      documentId,
      extracted: row != null,
      status: (row?.status as DocTextStatus | undefined) ?? null,
      charCount: row?.charCount ?? 0,
      extractedAt: row ? row.extractedAt.toISOString() : null,
      content: row?.content ?? null,
    };
  }

  // ---------- helpers ----------

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

  private async upsert(
    tenantId: string,
    documentId: string,
    content: string,
    status: DocTextStatus,
  ): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .insert(schema.documentText)
        .values({
          tenantId,
          documentId,
          content,
          charCount: content.length,
          status,
        })
        .onConflictDoUpdate({
          target: schema.documentText.documentId,
          set: {
            content,
            charCount: content.length,
            status,
            extractedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        }),
    );
  }
}
