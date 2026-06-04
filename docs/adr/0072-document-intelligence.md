# ADR-0072: Document intelligence — gated text extraction (PDF text-layer + Tesseract OCR) feeding the AI stack

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.6 (document intelligence — OCR + extraction) — sixth AI item of Horizon P5
**Builds on:** documents + S3 (P2.12 / P3.4), OpenSearch indexer (P3.6), preview queue (P2.13 / ADR-0043), vector pipeline (P5.2 / ADR-0068), semantic search + RAG + copilots (P5.3–P5.5)

## Context

P5.2–P5.5 (vectors, semantic search, RAG, copilots) all index/ground on a
document's `name + description` — the **full content** was never extracted. P5.6
adds OCR/text extraction so the AI stack can finally see document bodies. The
plan named Tesseract / PaddleOCR / docTR.

For the sovereign КЧС reality (**single-site, no GPU, on-prem/airgappable**) the
user's forks locked: **Tesseract + PDF text-layer** (CPU), **text only**
(classification/fields = follow-on), **async via BullMQ** (like preview P2.13),
and feed **OpenSearch `content` + the P5.2 re-embed**.

## Decision

A gated, async pipeline mirroring the preview pipeline. Split **a** (substrate) /
**b** (async + re-index).

### Storage — `document_text` sidecar (P5.6a)

Migration 0042 (+ RLS two-GUC): `tenant_id`, `document_id` (FK cascade,
**unique** → upsert), `content`, `char_count`, `status` (`done`/`empty`),
`extracted_at`. A **sidecar** (not a `documents` column) so the large text never
bloats document list/get queries (Postgres TOASTs it out-of-line).

### Gated extractor seam (P5.6a)

`TEXT_EXTRACTOR` (Noop / Real on `DOC_EXTRACT_ENABLED`). The real extractor is a
CPU/sovereign **live boundary**: PDF text-layer (`pdf-parse`) + Tesseract OCR
(`tesseract.js`, WASM, no GPU) for scans/images, imported via a **non-literal
specifier** so the OCR toolchain stays out of the build/test deps (installed on
the serving host only) and never enters jest (faked in e2e).

### Service + endpoints (P5.6a)

`DocumentExtractionService.extract(tenantId, docId)` (worker-safe via
`runForTenant`): load `ready` doc → `getObjectBytes` (S3) → `extractor.extract`
→ cap `DOC_EXTRACT_MAX_CHARS` → upsert; **503** disabled / **404** not-ready.
`POST /v1/documents/:id/extract` (`document:write`, sync) + `GET
/v1/documents/:id/text` (`document:read`). Config `DOC_EXTRACT_ENABLED` /
`MAX_CHARS` / `OCR_LANG` (`eng+rus`).

### Async + re-index (P5.6b)

Gated BullMQ `EXTRACT_QUEUE` + `ExtractWorker` (gated + isTest-skipped,
dynamic-imports bullmq/ioredis) — mirrors the preview queue. `DocumentsService`
**auto-enqueues** extraction on every finalize path (alongside the preview
enqueue, best-effort). After storing text, `extract()` **best-effort
re-indexes**: OpenSearch `indexDocument({…, content})` + `VectorIndexService`
re-embed with content (`IndexedDocument` + the vector `DocLike` gained an optional
`content`; OpenSearch mapping/payload/`multi_match` + `textOf` include it) — one
extraction makes keyword search, semantic search (P5.3), RAG (P5.4) and copilots
(P5.5) content-aware. Re-index never fails the extraction.

## Consequences

- **Positive:** the whole AI stack finally sees document bodies; fully gated
  (no-op in dev/test/CI); the OCR toolchain is a live boundary (zero build/test
  weight, airgap-friendly); async so it never blocks uploads; non-breaking
  (`content` optional everywhere — existing indexer/fakes unchanged).
- **Negative / trade-offs:** **text only** (classification + structured-field
  extraction are follow-ons); embeddings still cap at ~8k chars (no chunking yet
  — long docs embed a prefix); the embedding/OpenSearch re-index runs on the
  extract path (best-effort); real OCR accuracy/throughput is a live-smoke
  (Tesseract on the host); no per-page/lang auto-detect yet.

## Validation

- e2e `document-extraction` **7/7** (extract→store chars+status; idempotent
  upsert; empty; not-yet-extracted; 404; RBAC 403; 503 disabled) +
  `document-extract-pipeline` **2/2** (re-index → OpenSearch `content` + a
  `document_embeddings` row; auto-enqueue on finalize). Faked extractor/LLM/
  search-index/queue; real S3 (MinIO). Migration 0042 (+ RLS) by globalSetup.
- **Blast radius — 15 suites / 81 tests green serially** (documents×5, search×3,
  vector, rag, copilot, previews, extraction×2) → the `DocumentsService`
  finalize + `IndexedDocument`/`DocLike` `content` + module changes are
  non-breaking. `tsc`/eslint clean. Suite total **69 suites / 480 tests** (full
  green flush recommended on an unloaded host — the local env is saturated after
  a long session; see ADR-0071).
- **Boundary:** real PDF/Tesseract extraction + the BullMQ worker = manual
  live-smoke (`DOC_EXTRACT_ENABLED`, libs installed on the host).

## Files

- `packages/db/src/schema/document-text.ts` (+ migration 0042);
  `packages/contracts/src/document-text.ts`;
  `apps/api/src/modules/documents/` (`text-extractor.ts`/`.impl.ts`,
  `extract.queue.ts`/`extract-queue.impl.ts`, `extract.worker.ts`,
  `document-extraction.service.ts`, `document-extraction.controller.ts`,
  `documents.service.ts` enqueue, `documents.module.ts`);
  `search-index.ts`/`.impl.ts` (+`content`); `vector-index.service.ts`
  (`DocLike.content` + `textOf`); `DOC_EXTRACT_*` config.

## Follow-ons

- Classification (doc type/category) + structured field/entity extraction.
- Chunking long documents for multi-vector embedding (lifts the 8k cap).
- Per-page OCR + language auto-detect; OCR confidence in `document_text`.
- Web: show extracted text + an "extract" action on the document detail; a
  reindex-all-with-content backfill (mirrors `vector` reindex).
