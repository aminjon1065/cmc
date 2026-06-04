# ADR-0068: Vector pipeline — LLM-gateway embeddings + Postgres vector store + best-effort indexer

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.2 (vector pipeline) — second AI-substrate item of Horizon P5
**Builds on:** LLM gateway (P5.1 / ADR-0067), documents + OpenSearch indexer (P3.6 / ADR-0051), RLS
**Reshapes scope of:** the original "P5.2 — Vector pipeline + Qdrant"

## Context

The sequencing rule is "no AI feature before P5.1 + P5.2": after the LLM gateway,
the second AI substrate is the **embedding pipeline** that turns documents into
vectors for semantic search (P5.3). The plan named **Qdrant** and "migrate or
supplement pgvector".

Reality: the dev/test Postgres image is **PostGIS**, and combining it with the
**pgvector** extension in one image is non-trivial — and adding a
`CREATE EXTENSION vector` migration would break the whole test suite if the
extension isn't present. A dedicated Qdrant container is a heavy new gated
dependency. So the pragmatic, headless-testable first cut stores vectors **in
Postgres as a JSON column** (no extension), behind the gated AI substrate.

## Decision

### 1. Embeddings via the P5.1 LLM gateway

The gated `LlmProvider` gained `embed(texts, model)` (OpenAI-compatible
`/v1/embeddings`; `LLM_EMBED_MODEL`). One AI substrate serves chat *and*
embeddings (vLLM / Ollama / llama.cpp), faked in tests.

### 2. Postgres vector store (no extension)

`document_embeddings` (migration 0041): `tenant_id`, `document_id` (FK cascade,
**unique** → one vector per document, upsert), `model`, `dims`, `embedding`
**`jsonb`** (the `number[]`), timestamps. RLS-isolated (two-GUC). No pgvector
extension → the migration is safe everywhere; the **ANN index (pgvector) / Qdrant
is a scale follow-on** that swaps in without changing the pipeline. (P5.3
semantic search computes similarity over these vectors.)

### 3. Gated best-effort indexer (mirrors OpenSearch P3.6)

`VectorIndexService` is active only when **`VECTOR_ENABLED` AND the LLM provider
is up** — so it's a no-op in dev/test/CI (the provider is a noop there) and
whenever the LLM is off. It rides the document lifecycle: `DocumentsService`
calls `indexDocument` (embed + upsert) on **finalize** and `removeDocument` on
delete, both **best-effort** (never block or fail the document op). `reindexAll`
backfills; `status` reports `{ active, indexed }`. `VectorController`:
`POST /v1/vector/reindex` (`document:write`) + `GET /v1/vector/status`
(`document:read`).

## Consequences

- **Positive:** reuses the LLM gateway (one AI substrate) + existing Postgres
  (RLS, no new container, no extension risk); fully gated (no-op without the LLM)
  and e2e-tested against real Postgres; indexing is best-effort so it never
  breaks document finalize/delete.
- **Negative / trade-offs:** vectors are a `jsonb` array with **no ANN index** —
  P5.3 similarity is brute-force for now (fine at this scale; pgvector/Qdrant is
  the scale follow-on); embedding runs **inline** on finalize (adds latency;
  best-effort; an async NATS embedding worker is the follow-on); **documents
  only** (incidents/cases embeddings are follow-ons); no chunking yet (long docs
  embed name+description — full-content/extraction is P5.6); real embeddings need
  a live model server (manual live-smoke).

## Validation

- e2e `vector` **4/4**: reindex embeds all available documents (asserts dims /
  model / the stored vector); idempotent upsert (no duplicate rows); status
  `{active,indexed}`; RBAC 403 for a role-less viewer (status + reindex). Faked
  provider — no model server. Full backend suite **64 suites / 451 tests**, zero
  regressions; `tsc`/eslint clean. Migration 0041 (+ RLS) applied by globalSetup.
- **Boundary:** real embeddings via a live OpenAI-compatible endpoint = manual
  live-smoke.

## Files

- `apps/api/src/modules/vector/` (`vector-index.service.ts`, `vector.controller.ts`,
  `vector.module.ts`), `apps/api/src/modules/llm/llm.provider.ts` (`embed()`),
  `packages/db/src/schema/document-embeddings.ts` (+ migration 0041),
  `packages/contracts/src/vector.ts`, `DocumentsService` index/unindex hook,
  `LLM_EMBED_MODEL` / `VECTOR_ENABLED` config.

## Follow-ons

- **P5.3** semantic search (cosine over the vectors, permission-aware; hybrid
  with the P3.7 FTS/OpenSearch via RRF).
- pgvector ANN index / Qdrant at scale; async (NATS) embedding worker.
- Embed incidents + cases; chunk long documents; full-content extraction (P5.6).
