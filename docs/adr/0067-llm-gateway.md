# ADR-0067: LLM gateway — gated OpenAI-compatible provider seam + per-tenant rate-limit + metadata audit

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.1 (LLM gateway, self-hosted) — first item of Horizon P5
**Depends on:** RBAC (P1.1), audit (P1.11), Redis, the gated-seam convention (P2.5/P3.1/P4.7)

## Context

Horizon P5 (National scale) is the AI tier; the sequencing rule is **"no AI
feature before P5.1 + P5.2"** — so the LLM gateway is the substrate every later
feature (RAG P5.4, copilots P5.5) calls. The plan names **vLLM serving
Llama 3.x / Qwen / Mistral on internal GPUs, per-tenant rate-limit + audit**.

Two realities shape it: vLLM (like Ollama / llama.cpp) exposes an
**OpenAI-compatible** HTTP API, and this environment has **no GPU** and is
headless. So — exactly like NATS / ClickHouse / Temporal / LiveKit / Vault — the
gateway is a **gated seam**: the protocol client is testable with a fake; the
real GPU serving is a live/manual boundary.

## Decision

### 1. A gated, OpenAI-compatible provider seam

`LLM_PROVIDER` DI token + `NoopLlmProvider` (`active=false`) + `OpenAiCompatLlmProvider`
(plain `fetch` to `{LLM_BASE_URL}/v1/chat/completions`) + an async factory gated
on `LLM_ENABLED`. Speaking the **OpenAI chat-completions protocol over HTTP**
(no vendor SDK) keeps it portable across self-hosted backends (vLLM / Ollama /
llama.cpp) and any OpenAI-compatible endpoint. Off by default → noop, so
dev/test/CI need no model server; tests override the token with a fake provider.

### 2. `LlmService` — the cross-cutting concerns

The single seam future AI features call. Over the raw provider it adds:
- **Per-tenant rate limit** — a Redis fixed-window counter
  (`cmc:llm:rl:{tenantId}`, `LLM_RATE_LIMIT_PER_MIN`) → **429** when exceeded.
- **Audit of every call** — `llm.complete` with **metadata only** by default
  (model, token counts, latency, `messageCount`, outcome); raw prompts/responses
  are recorded **only** when `LLM_LOG_PROMPTS` is set. Failure audits are
  `durable` (survive the request rollback that the thrown error triggers).
- **Mapped failures**: **503** when the gateway is disabled, **502** on a
  provider error, **400** on a bad request.

### 3. Endpoint

`POST /v1/llm/complete` (`@Authorize("llm:use")`, granted to operator +
tenant_admin), non-streaming MVP. New `llm:use` permission; contracts
`LlmCompleteRequest`/`Response` (zod). No DB schema (config-only).

### 4. Metadata-only audit (sovereignty)

For a sovereign crisis platform, prompts/responses may carry sensitive data, so
they are **not** written to the tamper-evident audit log by default — only the
operational metadata an audit needs (who/when/which-model/how-many-tokens).
`LLM_LOG_PROMPTS` is the explicit opt-in.

## Consequences

- **Positive:** one gated, provider-agnostic seam for all AI features; portable
  (OpenAI-compatible, no lock-in); per-tenant rate-limited + audited; sovereign
  by default; zero infra for dev/test (faked provider); the access JWT stays
  server-side (BFF).
- **Negative / trade-offs:** **non-streaming** (SSE token streaming is a
  follow-on); a single fixed-window rate limit (token-bucket / per-user is a
  follow-on); one chat endpoint (embeddings = P5.2; RAG/copilots = P5.4+); the
  real vLLM/GPU serving is a **manual/live boundary** (compose profile + GPU
  host), not exercised headless.

## Validation

- e2e `llm` **5/5**: Noop factory when disabled; completion round-trip +
  **metadata-only audit** (asserts the raw prompt is absent from `audit_log`);
  403 without `llm:use`; 400 on empty messages; 429 on the per-tenant limit
  (faked provider — no GPU/network). Full backend suite **63 suites / 447 tests**,
  zero regressions; `tsc`/eslint clean. Config-only (no migration).
- **Boundary:** real vLLM serving + a live completion = manual live-smoke
  (`LLM_ENABLED=true` + a GPU-backed OpenAI-compatible endpoint).

## Files

- `apps/api/src/modules/llm/` (`llm.provider.ts` seam, `llm.service.ts`,
  `llm.controller.ts`, `llm.module.ts`), `packages/contracts/src/llm.ts`,
  `llm:use` in the RBAC catalog, `LLM_*` config.

## Follow-ons

- **P5.2** vector pipeline + embeddings endpoint on this gateway.
- SSE token **streaming**; token-bucket + per-user rate limits.
- Model routing / fallback / multi-model; prompt-injection guardrails.
- vLLM **compose profile** + GPU deployment manifest (the live serving backend).
