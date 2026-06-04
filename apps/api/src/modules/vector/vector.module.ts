import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { VectorIndexService } from "./vector-index.service";
import { VectorController } from "./vector.controller";

/**
 * Vector pipeline module (P5.2 / ADR-0068). VectorIndexService uses the gated
 * `LLM_PROVIDER` (embeddings, from LlmModule) + TenantDatabaseService (@Global).
 * Exported so DocumentsService can index on finalize/delete (best-effort).
 */
@Module({
  imports: [LlmModule],
  controllers: [VectorController],
  providers: [VectorIndexService],
  exports: [VectorIndexService],
})
export class VectorModule {}
