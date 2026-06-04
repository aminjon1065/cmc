# ADR-0070: RAG framework — strictly-grounded, cited, audited Q&A composed from the existing AI seams

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.4 (RAG framework) — fourth AI item of Horizon P5
**Builds on:** semantic search (P5.3 / ADR-0069), federated `/v1/search` (P3.7 / ADR-0052), LLM gateway (P5.1 / ADR-0067), audit (P1.11)

## Context

With permission-aware hybrid retrieval (P5.3) and the audited LLM gateway (P5.1)
in place, P5.4 is the **retrieval → context → LLM → citations → audit** loop.
The risk in a sovereign crisis-management system is an LLM that **hallucinates**
or leaks data across permission boundaries. So RAG must (a) ground answers only
in what the **caller may already read**, (b) **cite** its sources, and (c) leave
an **auditable provenance** trail.

Four forks were locked with the user:
1. **Retrieval:** reuse the P5.3 hybrid `/v1/search` (`SearchService`) — already
   permission-filtered + cross-domain — not a new vector-only retriever.
2. **Grounding:** **strict** — answer only from the provided context, with inline
   `[n]` citations; say "I don't know" otherwise.
3. **Surface:** a dedicated **`POST /v1/rag/ask`**, not a flag on `/v1/llm/complete`.
4. **Audit:** **metadata + cited source ids** (provenance), not the raw
   question/answer — mirroring the P5.1 sovereignty posture.

## Decision

RAG is a **composition seam — no new model, store, or migration.**

### `RagService.ask` (composition)

1. **Gate:** 503 if the LLM provider is inactive (mirrors the gateway).
2. **Retrieve:** `SearchService.search(tenant, user, question, topK)` — the hits
   are already RBAC- + folder-access-filtered to this caller (so RAG inherits
   permission-aware retrieval; it can only ground in what the caller may read).
3. **No sources → honest no-answer with NO LLM call:** returns
   `"I could not find an answer in the available sources."`, `grounded:false`,
   zero usage (still audited).
4. **Assemble context:** numbered blocks from each hit's available text
   (`title + snippet` — documents are name+description until P5.6), bounded by a
   per-source + total **character budget** (`RAG_CONTEXT_CHAR_BUDGET`) so a long
   tail can't blow the prompt.
5. **Generate:** via `LlmService.complete` (so RAG inherits the **per-tenant rate
   limit**, **provider-error → 502** mapping, and the metadata-only
   `llm.complete` audit) with a **strict-grounding system prompt** (answer only
   from the sources; cite `[n]`; else the exact no-answer line) at `temperature 0`.
6. **Resolve citations:** parse `[n]` markers → distinct, in-range sources →
   `citations[]` (`{type, id, title}`); `grounded` = at least one cited.
7. **Audit `rag.ask`:** metadata = model, latency, retrieved/cited counts,
   `grounded`, token usage, and **`citedSources` (type+id)** — provenance only;
   the raw question/answer are recorded **only** under `LLM_LOG_PROMPTS`.
   Failure audits are `durable` (survive request rollback).

### Endpoint + contracts

`POST /v1/rag/ask` (`@Authorize llm:use`, Zod-validated → 400) → `{answer,
citations[], grounded, model, usage}`. Contracts in `rag.ts`; config `RAG_TOP_K`
(5) + `RAG_CONTEXT_CHAR_BUDGET` (6000). No new permission (reuses `llm:use`); the
defense-in-depth is the permission-filtered retrieval.

## Consequences

- **Positive:** zero new infrastructure — RAG inherits gating, rate-limit, audit
  (P5.1) + permission-aware hybrid retrieval (P5.3) for free; strict grounding +
  citations curb hallucination and give provenance; the no-source short-circuit
  avoids a wasted LLM call; sovereign audit posture preserved (no raw text by
  default).
- **Negative / trade-offs:** context is **title + snippet** (documents are
  name+description until full-content extraction + chunking in P5.6), so grounding
  depth is limited for long documents; generation is **synchronous** (no
  streaming yet); citation parsing trusts the model's `[n]` markers (out-of-range
  dropped); the no-source path is **not** rate-limited (no LLM call — a separate
  RAG limit is a follow-on); real answers need a live model server (manual
  live-smoke).

## Validation

- e2e `rag` **6/6**: grounded answer + `[n]`→incident-id citation; honest
  no-answer with **no LLM call** (chat-call counter unchanged); **metadata-only
  `rag.ask` audit** (cited ids present, the raw question sentinel **absent**);
  RBAC 403 without `llm:use`; 400 on empty question; **503** when the gateway is
  disabled. Faked provider; retrieval is the real permission-aware hybrid path.
- Full backend suite **66 suites / 464 tests**, zero regressions; `tsc`/eslint
  clean.
- **Boundary:** real generation via a live OpenAI-compatible endpoint = manual
  live-smoke.

## Files

- `apps/api/src/modules/rag/` (`rag.service.ts`, `rag.controller.ts`,
  `rag.module.ts`); `packages/contracts/src/rag.ts`; `RAG_TOP_K` +
  `RAG_CONTEXT_CHAR_BUDGET` config; `app.module.ts` wiring;
  `apps/api/test/e2e/rag.e2e-spec.ts`.

## Follow-ons

- SSE streaming answers; per-user / RAG-specific rate limit.
- Richer context: full-document content + chunking (after P5.6 OCR/extraction);
  embed + ground in incidents/cases bodies (after the P5.2 follow-on).
- **P5.5** per-module copilots build on this (GIS/Docs/Workflow/Incidents).
- Web: a RAG "ask" UI with rendered citations (links to the cited resources).
- Answer-faithfulness eval harness; citation-coverage scoring.
