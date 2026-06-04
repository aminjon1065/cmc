import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentsService } from "./documents.service";
import { RetentionService } from "./retention.service";
import { DocumentsController } from "./documents.controller";
import { DocumentExtractionService } from "./document-extraction.service";
import { DocumentExtractionController } from "./document-extraction.controller";
import { TEXT_EXTRACTOR, createTextExtractor } from "./text-extractor";
import { EXTRACT_QUEUE, createExtractQueue } from "./extract.queue";
import { ExtractWorker } from "./extract.worker";
import { FoldersModule } from "../folders/folders.module";
import { SearchModule } from "../search/search.module";
import { VectorModule } from "../vector/vector.module";

/**
 * Documents module (P3.4+). Adds the gated `TEXT_EXTRACTOR` seam +
 * `DocumentExtractionService` (P5.6 / ADR-0072) for OCR/text extraction.
 */
@Module({
  imports: [FoldersModule, SearchModule, VectorModule],
  providers: [
    DocumentsService,
    RetentionService,
    DocumentExtractionService,
    ExtractWorker,
    {
      provide: TEXT_EXTRACTOR,
      inject: [ConfigService],
      useFactory: createTextExtractor,
    },
    {
      provide: EXTRACT_QUEUE,
      inject: [ConfigService],
      useFactory: createExtractQueue,
    },
  ],
  controllers: [DocumentsController, DocumentExtractionController],
  exports: [DocumentsService, DocumentExtractionService],
})
export class DocumentsModule {}
