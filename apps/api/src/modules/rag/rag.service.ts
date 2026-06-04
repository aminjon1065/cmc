import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  LlmUsage,
  RagAskRequest,
  RagAskResponse,
  RagCitation,
} from "@cmc/contracts";
import { AuditService } from "../audit/audit.service";
import { SearchService } from "../search/search.service";
import { LlmService } from "../llm/llm.service";
import { LLM_PROVIDER, type LlmProvider } from "../llm/llm.provider";
import { assembleContext, resolveCitations } from "./grounding";
import type { AppConfig } from "../../config/configuration";

type Actor = { userId: string; tenantId: string };

const ZERO_USAGE: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/** Said verbatim by the model (per the system prompt) and used when no sources. */
const NO_ANSWER = "I could not find an answer in the available sources.";

const SYSTEM_PROMPT = [
  "You are a careful assistant for an emergency-management platform.",
  "Answer the user's question using ONLY the numbered sources provided.",
  "Cite every source you use inline with its bracket number, e.g. [1] or [2].",
  "Do not use any outside knowledge and do not invent sources.",
  `If the sources do not contain the answer, reply exactly: "${NO_ANSWER}"`,
  "Be concise.",
].join(" ");

/**
 * RAG service (P5.4 / ADR-0070). Composes the existing AI seams — it does NOT add
 * a new model or store: retrieval reuses the **permission-aware hybrid**
 * `SearchService` (P5.3), generation reuses `LlmService` (P5.1: per-tenant
 * rate-limit, provider-error mapping, metadata-only `llm.complete` audit). On top
 * it enforces **strict grounding** (answer only from the retrieved context, with
 * `[n]` citations) and writes a **`rag.ask`** audit recording *provenance* (the
 * cited source ids) — never the raw question/answer unless `LLM_LOG_PROMPTS`.
 * Retrieval is permission-filtered per the caller, so RAG can only ground in what
 * the caller may already read. 503 when the LLM gateway is disabled.
 */
@Injectable()
export class RagService {
  private readonly defaultTopK: number;
  private readonly contextBudget: number;
  private readonly defaultModel: string;
  private readonly logPrompts: boolean;

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly search: SearchService,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultTopK = config.get("RAG_TOP_K", { infer: true });
    this.contextBudget = config.get("RAG_CONTEXT_CHAR_BUDGET", { infer: true });
    this.defaultModel = config.get("LLM_MODEL", { infer: true });
    this.logPrompts = config.get("LLM_LOG_PROMPTS", { infer: true });
  }

  async ask(actor: Actor, req: RagAskRequest): Promise<RagAskResponse> {
    if (!this.provider.active) {
      throw new ServiceUnavailableException("LLM gateway is disabled");
    }
    const question = req.question.trim();
    const topK = req.topK ?? this.defaultTopK;
    const started = Date.now();

    // 1. Permission-aware hybrid retrieval (reuses P5.3 /v1/search). The hits are
    //    already filtered to what this caller may read (per-domain RBAC + folders).
    const retrieval = await this.search.search(
      actor.tenantId,
      actor.userId,
      question,
      topK,
    );
    const { sources, contextText } = assembleContext(
      retrieval.results.slice(0, topK),
      this.contextBudget,
    );

    // 2. No accessible sources → an honest "don't know", with NO LLM call.
    if (sources.length === 0) {
      await this.writeAudit(actor, this.defaultModel, ZERO_USAGE, started, {
        outcome: "success",
        retrieved: retrieval.results.length,
        cited: [],
        grounded: false,
        question,
        answer: NO_ANSWER,
      });
      return {
        answer: NO_ANSWER,
        citations: [],
        grounded: false,
        model: this.defaultModel,
        usage: ZERO_USAGE,
      };
    }

    // 3. Strict-grounding generation via the LLM gateway (rate-limit + audit there).
    let content: string;
    let model: string;
    let usage: LlmUsage;
    try {
      const res = await this.llm.complete(actor, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Sources:\n${contextText}\n\nQuestion: ${question}`,
          },
        ],
        temperature: 0,
      });
      content = res.content;
      model = res.model;
      usage = res.usage;
    } catch (err) {
      await this.writeAudit(actor, this.defaultModel, null, started, {
        outcome: "failure",
        retrieved: retrieval.results.length,
        cited: [],
        grounded: false,
        question,
      });
      throw err; // LlmService already mapped to 502 / 503 / 429.
    }

    // 4. Resolve inline [n] markers to the cited sources.
    const citations = resolveCitations(content, sources);
    const grounded = citations.length > 0;
    await this.writeAudit(actor, model, usage, started, {
      outcome: "success",
      retrieved: retrieval.results.length,
      cited: citations,
      grounded,
      question,
      answer: content,
    });
    return { answer: content, citations, grounded, model, usage };
  }

  private async writeAudit(
    actor: Actor,
    model: string,
    usage: LlmUsage | null,
    started: number,
    meta: {
      outcome: "success" | "failure";
      retrieved: number;
      cited: RagCitation[];
      grounded: boolean;
      question: string;
      answer?: string;
    },
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "rag.ask",
      resourceType: "rag",
      resourceId: model.slice(0, 128),
      outcome: meta.outcome,
      durable: meta.outcome === "failure",
      metadata: {
        model,
        latencyMs: Date.now() - started,
        retrievedCount: meta.retrieved,
        citedCount: meta.cited.length,
        // Provenance: which sources grounded the answer (ids, not the text).
        citedSources: meta.cited.map((c) => ({ type: c.type, id: c.id })),
        grounded: meta.grounded,
        ...(usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : {}),
        // Raw question/answer only when explicitly opted in (sovereignty).
        ...(this.logPrompts
          ? { question: meta.question, answer: meta.answer ?? null }
          : {}),
      },
    });
  }
}
