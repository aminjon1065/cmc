import { Module } from "@nestjs/common";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { FoldersModule } from "../folders/folders.module";

/**
 * Search module (P2.11 / ADR-0041) — Postgres full-text search across incidents,
 * cases, and documents (name/description). OpenSearch and the vector/semantic
 * lane were removed in ADR-0080; discovery is Postgres FTS only.
 */
@Module({
  imports: [FoldersModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
