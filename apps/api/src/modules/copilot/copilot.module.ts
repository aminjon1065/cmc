import { Module } from "@nestjs/common";
import { CopilotService } from "./copilot.service";
import { CopilotController } from "./copilot.controller";
import { SearchModule } from "../search/search.module";
import { LlmModule } from "../llm/llm.module";
import { IncidentsModule } from "../incidents/incidents.module";

/**
 * Copilot module (P5.5 / ADR-0071). Composes the hybrid retriever (SearchModule /
 * P5.3), the LLM gateway (LlmModule / P5.1), and per-module record loaders
 * (IncidentsModule for the first copilot) into a unified, read-only, grounded
 * `/v1/copilot/ask`. RBAC/Audit/TenantDatabase are @Global. No new model/store.
 */
@Module({
  imports: [SearchModule, LlmModule, IncidentsModule],
  providers: [CopilotService],
  controllers: [CopilotController],
  exports: [CopilotService],
})
export class CopilotModule {}
