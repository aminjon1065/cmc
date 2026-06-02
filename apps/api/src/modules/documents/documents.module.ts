import { Module } from "@nestjs/common";
import { DocumentsService } from "./documents.service";
import { RetentionService } from "./retention.service";
import { DocumentsController } from "./documents.controller";
import { FoldersModule } from "../folders/folders.module";
import { SearchModule } from "../search/search.module";

@Module({
  imports: [FoldersModule, SearchModule],
  providers: [DocumentsService, RetentionService],
  controllers: [DocumentsController],
  exports: [DocumentsService],
})
export class DocumentsModule {}
