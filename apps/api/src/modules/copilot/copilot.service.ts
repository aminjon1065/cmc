import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  CopilotAskRequest,
  CopilotAskResponse,
  CopilotModule as CopilotModuleName,
  LlmUsage,
  Permission,
  RagCitation,
  SearchResult,
  SearchResultType,
} from "@cmc/contracts";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { SearchService } from "../search/search.service";
import { LlmService } from "../llm/llm.service";
import { LLM_PROVIDER, type LlmProvider } from "../llm/llm.provider";
import { IncidentsService } from "../incidents/incidents.service";
import { assembleContext, resolveCitations } from "../rag/grounding";
import type { AppConfig } from "../../config/configuration";

type Actor = { userId: string; tenantId: string };

/** Per-module config: read-perm gate, retrieval domain, prompt, record anchor. */
type ModuleConfig = {
  readPermission: Permission;
  domainTypes: SearchResultType[];
  systemPrompt: string;
  /** Load an accessible record as a pinned source, or null if inaccessible. */
  loadAnchor: (id: string) => Promise<SearchResult | null>;
};

const ZERO_USAGE: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

const NO_ANSWER = "I could not find an answer in the available sources.";

const INCIDENTS_PROMPT = [
  "You are an incident-management copilot for an emergency operations center.",
  "Answer the operator's question using ONLY the numbered incident sources provided.",
  "Cite every source you use inline with its bracket number, e.g. [1].",
  "Do not use outside knowledge and do not invent details.",
  `If the sources do not contain the answer, reply exactly: "${NO_ANSWER}"`,
  "Be concise and operational.",
].join(" ");

/**
 * Copilot service (P5.5 / ADR-0071). A **read-only, module-scoped** assistant
 * built entirely from the existing AI seams — retrieval is the permission-aware
 * hybrid `SearchService` (P5.3) filtered to the module's domain, optionally
 * anchored on a specific record; generation + strict grounding + citations +
 * audit follow the RAG pattern (P5.4, shared `grounding` helpers). Per-module
 * behaviour (read-perm, retrieval domain, prompt, anchor loader) lives in a
 * registry — the first module is `incidents`; GIS/documents/workflow are
 * follow-ons behind the same unified `/v1/copilot/ask`. No new model or store.
 */
@Injectable()
export class CopilotService {
  private readonly defaultTopK: number;
  private readonly contextBudget: number;
  private readonly defaultModel: string;
  private readonly logPrompts: boolean;
  private readonly modules: Record<CopilotModuleName, ModuleConfig>;

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly rbac: RbacService,
    private readonly search: SearchService,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
    private readonly incidents: IncidentsService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultTopK = config.get("RAG_TOP_K", { infer: true });
    this.contextBudget = config.get("RAG_CONTEXT_CHAR_BUDGET", { infer: true });
    this.defaultModel = config.get("LLM_MODEL", { infer: true });
    this.logPrompts = config.get("LLM_LOG_PROMPTS", { infer: true });

    this.modules = {
      incidents: {
        readPermission: "incident:read",
        domainTypes: ["incident"],
        systemPrompt: INCIDENTS_PROMPT,
        loadAnchor: async (id) => {
          const d = await this.incidents.getDetail(id);
          if (!d) return null;
          const meta = `[status=${d.status}, severity=${d.severity}, type=${d.type}, region=${d.region}]`;
          return {
            type: "incident",
            id: d.id,
            title: d.summary,
            snippet: [d.description, meta].filter(Boolean).join(" "),
            score: 1,
            source: "postgres",
          };
        },
      },
    };
  }

  async ask(actor: Actor, req: CopilotAskRequest): Promise<CopilotAskResponse> {
    if (!this.provider.active) {
      throw new ServiceUnavailableException("LLM gateway is disabled");
    }
    const cfg = this.modules[req.module];
    const question = req.question.trim();
    const topK = req.topK ?? this.defaultTopK;
    const started = Date.now();

    // Module read-perm gate: a caller with llm:use but without the module's read
    // permission gets an honest no-answer (no data to ground in) — never a leak.
    const perms = await this.rbac.resolvePermissions(actor.tenantId, actor.userId);
    const canRead = perms.has(cfg.readPermission);

    // Optional record anchor (pinned first), only when accessible.
    const anchorHits: SearchResult[] = [];
    if (canRead && req.resourceId) {
      const anchor = await cfg.loadAnchor(req.resourceId);
      if (anchor) anchorHits.push(anchor);
    }

    // Module-scoped retrieval via the permission-aware hybrid search.
    let retrieved: SearchResult[] = [];
    if (canRead) {
      const r = await this.search.search(
        actor.tenantId,
        actor.userId,
        question,
        topK,
      );
      retrieved = r.results.filter((h) => cfg.domainTypes.includes(h.type));
    }

    // Merge anchor + retrieved, deduped by id (anchor pinned first).
    const seen = new Set<string>();
    const hits: SearchResult[] = [];
    for (const h of [...anchorHits, ...retrieved]) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      hits.push(h);
    }
    const { sources, contextText } = assembleContext(hits, this.contextBudget);

    // No accessible sources → honest no-answer, NO LLM call.
    if (sources.length === 0) {
      await this.writeAudit(actor, req, this.defaultModel, ZERO_USAGE, started, {
        outcome: "success",
        retrieved: retrieved.length,
        cited: [],
        grounded: false,
        question,
      });
      return {
        answer: NO_ANSWER,
        citations: [],
        grounded: false,
        model: this.defaultModel,
        usage: ZERO_USAGE,
      };
    }

    let content: string;
    let model: string;
    let usage: LlmUsage;
    try {
      const res = await this.llm.complete(actor, {
        messages: [
          { role: "system", content: cfg.systemPrompt },
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
      await this.writeAudit(actor, req, this.defaultModel, null, started, {
        outcome: "failure",
        retrieved: retrieved.length,
        cited: [],
        grounded: false,
        question,
      });
      throw err; // LlmService already mapped to 502 / 503 / 429.
    }

    const citations = resolveCitations(content, sources);
    const grounded = citations.length > 0;
    await this.writeAudit(actor, req, model, usage, started, {
      outcome: "success",
      retrieved: retrieved.length,
      cited: citations,
      grounded,
      question,
      answer: content,
    });
    return { answer: content, citations, grounded, model, usage };
  }

  private async writeAudit(
    actor: Actor,
    req: CopilotAskRequest,
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
      action: "copilot.ask",
      resourceType: "copilot",
      resourceId: req.module.slice(0, 128),
      outcome: meta.outcome,
      durable: meta.outcome === "failure",
      metadata: {
        module: req.module,
        model,
        latencyMs: Date.now() - started,
        ...(req.resourceId ? { anchorResourceId: req.resourceId } : {}),
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
