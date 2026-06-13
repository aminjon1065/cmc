import { Module } from "@nestjs/common";
import { DocumentsService } from "./documents.service";
import { RetentionService } from "./retention.service";
import { DocumentsController } from "./documents.controller";
import { FoldersModule } from "../folders/folders.module";

/**
 * Documents module (P3.4+) — EDMS lifecycle, versioning, retention/legal hold.
 * Content lives in MinIO; metadata + state in Postgres. Discovery is Postgres
 * FTS via the search module (no OpenSearch / embeddings — ADR-0080).
 */
@Module({
  imports: [FoldersModule],
  providers: [DocumentsService, RetentionService],
  controllers: [DocumentsController],
  exports: [DocumentsService],
})
export class DocumentsModule {}
