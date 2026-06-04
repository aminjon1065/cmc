import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Redis } from "ioredis";
import type { LlmCompleteRequest, LlmCompleteResponse } from "@cmc/contracts";
import { AuditService } from "../audit/audit.service";
import { REDIS } from "../redis/redis.tokens";
import { LLM_PROVIDER, type LlmProvider } from "./llm.provider";
import type { AppConfig } from "../../config/configuration";

type Actor = { userId: string; tenantId: string };

/**
 * LLM gateway (P5.1 / ADR-0067). The single seam every future AI feature
 * (RAG, copilots) calls. Adds two cross-cutting concerns over the raw provider:
 * a **per-tenant rate limit** (Redis fixed-window) and an **audit** of every
 * call — metadata-only by default (model, tokens, latency, outcome); raw
 * prompts/responses are recorded only when `LLM_LOG_PROMPTS` is set
 * (sovereignty/privacy). Returns 503 when the gateway is disabled.
 */
@Injectable()
export class LlmService {
  private readonly defaultModel: string;
  private readonly ratePerMin: number;
  private readonly logPrompts: boolean;

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultModel = config.get("LLM_MODEL", { infer: true });
    this.ratePerMin = config.get("LLM_RATE_LIMIT_PER_MIN", { infer: true });
    this.logPrompts = config.get("LLM_LOG_PROMPTS", { infer: true });
  }

  async complete(
    actor: Actor,
    req: LlmCompleteRequest,
  ): Promise<LlmCompleteResponse> {
    if (!this.provider.active) {
      throw new ServiceUnavailableException("LLM gateway is disabled");
    }
    await this.enforceRateLimit(actor.tenantId);

    const model = req.model?.trim() || this.defaultModel;
    const started = Date.now();
    try {
      const result = await this.provider.chat({
        model,
        messages: req.messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
      });
      await this.writeAudit(actor, result.model, result.usage, started, "success", req);
      return {
        content: result.content,
        model: result.model,
        usage: result.usage,
        finishReason: result.finishReason,
      };
    } catch (err) {
      await this.writeAudit(actor, model, null, started, "failure", req);
      throw new BadGatewayException(
        `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Per-tenant fixed-window (1 min) rate limit via Redis. */
  private async enforceRateLimit(tenantId: string): Promise<void> {
    const key = `cmc:llm:rl:${tenantId}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 60);
    if (n > this.ratePerMin) {
      throw new HttpException(
        `LLM rate limit exceeded (${this.ratePerMin}/min)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async writeAudit(
    actor: Actor,
    model: string,
    usage: LlmCompleteResponse["usage"] | null,
    started: number,
    outcome: "success" | "failure",
    req: LlmCompleteRequest,
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "llm.complete",
      resourceType: "llm",
      resourceId: model.slice(0, 128),
      outcome,
      // Failure audits must survive the request rollback (they also throw).
      durable: outcome === "failure",
      metadata: {
        model,
        latencyMs: Date.now() - started,
        messageCount: req.messages.length,
        ...(usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : {}),
        // Raw prompts/responses only when explicitly opted in (sovereignty).
        ...(this.logPrompts ? { messages: req.messages } : {}),
      },
    });
  }
}
