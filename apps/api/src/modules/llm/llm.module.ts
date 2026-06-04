import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LLM_PROVIDER, createLlmProvider } from "./llm.provider";
import { LlmService } from "./llm.service";
import { LlmController } from "./llm.controller";

/**
 * LLM gateway module (P5.1 / ADR-0067). Provides the gated `LLM_PROVIDER`
 * (real OpenAI-compatible client when `LLM_ENABLED`, else a noop) + `LlmService`
 * (per-tenant rate-limit + audit, using @Global TenantDatabase/Audit/Redis).
 * Exported so future AI features (RAG, copilots) inject `LlmService`.
 */
@Module({
  controllers: [LlmController],
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: createLlmProvider,
    },
    LlmService,
  ],
  exports: [LlmService, LLM_PROVIDER],
})
export class LlmModule {}
