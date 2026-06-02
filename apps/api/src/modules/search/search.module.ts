import { Module } from "@nestjs/common";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";

/**
 * Search module (P2.11 / ADR-0041). SearchService uses TenantDatabaseService +
 * RbacService (both @Global). No extra imports needed.
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
