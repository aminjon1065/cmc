import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the LLM provider seam (P5.1 / ADR-0067). */
export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

export type LlmChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type LlmChatRequest = {
  model: string;
  messages: LlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
};
export type LlmChatResult = {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
};

export type LlmEmbedResult = {
  embeddings: number[][];
  model: string;
  usage: { promptTokens: number; totalTokens: number };
};

/** Thin provider seam — faked in tests; the real one talks OpenAI-compatible HTTP. */
export interface LlmProvider {
  readonly active: boolean;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
  /** Embed one or more texts (OpenAI-compatible `/v1/embeddings`) — P5.2. */
  embed(texts: string[], model: string): Promise<LlmEmbedResult>;
}

/** Disabled gateway — `active=false`; the service maps this to 503. */
export class NoopLlmProvider implements LlmProvider {
  readonly active = false;
  async chat(): Promise<LlmChatResult> {
    throw new Error("LLM gateway is disabled (LLM_ENABLED=false)");
  }
  async embed(): Promise<LlmEmbedResult> {
    throw new Error("LLM gateway is disabled (LLM_ENABLED=false)");
  }
}

/**
 * Real provider — speaks the OpenAI-compatible `/v1/chat/completions` protocol
 * over plain HTTP (fetch), so it works against self-hosted vLLM / Ollama /
 * llama.cpp without a vendor SDK. The serving backend (GPU) is a live boundary.
 */
export class OpenAiCompatLlmProvider implements LlmProvider {
  readonly active = true;
  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey?: string;
      timeoutMs: number;
    },
  ) {}

  async chat(req: LlmChatRequest): Promise<LlmChatResult> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey
          ? { Authorization: `Bearer ${this.opts.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LLM provider returned ${res.status} ${res.statusText}${
          body ? ` — ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    const json = (await res.json()) as {
      model?: string;
      choices?: {
        message?: { content?: string };
        finish_reason?: string;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      model: json.model ?? req.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? "stop",
    };
  }

  async embed(texts: string[], model: string): Promise<LlmEmbedResult> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey
          ? { Authorization: `Bearer ${this.opts.apiKey}` }
          : {}),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `LLM embeddings returned ${res.status} ${res.statusText}${
          body ? ` — ${body.slice(0, 200)}` : ""
        }`,
      );
    }
    const json = (await res.json()) as {
      model?: string;
      data?: { embedding?: number[] }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    return {
      embeddings: (json.data ?? []).map((d) => d.embedding ?? []),
      model: json.model ?? model,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
    };
  }
}

/** Factory: the real OpenAI-compatible client when enabled, else the noop. */
export function createLlmProvider(
  config: ConfigService<AppConfig, true>,
): LlmProvider {
  if (!config.get("LLM_ENABLED", { infer: true })) {
    return new NoopLlmProvider();
  }
  return new OpenAiCompatLlmProvider({
    baseUrl: config.get("LLM_BASE_URL", { infer: true }),
    apiKey: config.get("LLM_API_KEY", { infer: true }),
    timeoutMs: config.get("LLM_TIMEOUT_MS", { infer: true }),
  });
}
