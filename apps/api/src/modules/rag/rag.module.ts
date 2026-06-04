import { Module } from "@nestjs/common";
import { RagService } from "./rag.service";
import { RagController } from "./rag.controller";
import { SearchModule } from "../search/search.module";
import { LlmModule } from "../llm/llm.module";

/**
 * RAG module (P5.4 / ADR-0070). Composes the hybrid retriever (SearchModule /
 * P5.3) and the LLM gateway (LlmModule / P5.1) into a strictly-grounded,
 * cited, audited question-answering endpoint. Audit/TenantDatabase/Redis are
 * @Global. No new model or store — RAG is a composition seam.
 */
@Module({
  imports: [SearchModule, LlmModule],
  providers: [RagService],
  controllers: [RagController],
  exports: [RagService],
})
export class RagModule {}
