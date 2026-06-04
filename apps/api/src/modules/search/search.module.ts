import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { FoldersModule } from "../folders/folders.module";
import { VectorModule } from "../vector/vector.module";
import {
  SEARCH_INDEX,
  type SearchIndex,
  createSearchIndex,
} from "./search-index";

/** Creates the OpenSearch index + mapping at boot when the index is active. */
@Injectable()
class SearchIndexBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SearchIndexBootstrap.name);
  constructor(@Inject(SEARCH_INDEX) private readonly index: SearchIndex) {}
  async onModuleInit(): Promise<void> {
    if (!this.index.active) return;
    try {
      await this.index.ensureIndex();
      this.logger.log("OpenSearch documents index ready");
    } catch (err) {
      this.logger.error(
        `OpenSearch ensureIndex failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Search module (P2.11 / ADR-0041; P3.6 / ADR-0051). SearchService (Postgres FTS)
 * + the gated OpenSearch `SEARCH_INDEX` seam (Noop unless OPENSEARCH_ENABLED).
 * Exports SEARCH_INDEX so DocumentsService can index on write.
 */
@Module({
  imports: [FoldersModule, VectorModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    {
      provide: SEARCH_INDEX,
      inject: [ConfigService],
      useFactory: createSearchIndex,
    },
    SearchIndexBootstrap,
  ],
  exports: [SearchService, SEARCH_INDEX],
})
export class SearchModule {}
