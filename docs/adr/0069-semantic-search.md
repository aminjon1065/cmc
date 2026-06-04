# ADR-0069: Semantic search — brute-force vector kNN fused into federated search by RRF

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.3 (semantic search) — third AI item of Horizon P5
**Builds on:** vector pipeline (P5.2 / ADR-0068), federated `/v1/search` + RRF (P3.7 / ADR-0052), folder access (P3.3b / ADR-0048), LLM gateway (P5.1 / ADR-0067)

## Context

P5.2 populates `document_embeddings` (Postgres `jsonb`, RLS) via the LLM-gateway
`embed()`. P5.3 turns those vectors into **retrieval**: a semantic lane that
finds documents by meaning, not keywords, and is **permission-aware**. The plan
called for "hybrid BM25 + vector kNN".

The federated `/v1/search` (P3.7) already fans out per-domain lanes (incidents +
cases via Postgres FTS; documents via OpenSearch with an FTS fallback), each
folder-access filtered, and fuses them by **Reciprocal Rank Fusion (RRF)**. The
cleanest hybrid is to add the vector kNN as **one more lane** into that same
machinery rather than a parallel endpoint.

Three forks were locked with the user:
1. **Similarity:** brute-force cosine over the `jsonb` vectors (no pgvector) —
   consistent with P5.2 (pgvector/Qdrant = scale follow-on), no PostGIS-image
   risk, fine at single-site scale.
2. **Fusion:** **RRF**, reusing the P3.7 pattern (no normalisation of
   incompatible scorer scales).
3. **Surface:** **fold into `/v1/search`** (one search surface), not a separate
   `/v1/search/semantic`.

(Vectors are **documents-only** today — P5.2 deferred incident/case embeddings —
so the vector lane augments the documents portion; incidents/cases stay keyword.)

## Decision

### 1. Brute-force cosine kNN (`cosine.ts` + `VectorIndexService.similar`)

A pure, dependency-free `cosineSimilarity(a, b)` (returns `0` for the
non-comparable cases — mismatched dims, zero magnitude — so a bad embedding can
never out-rank a real match). `VectorIndexService.similar(query, cap)` (gated on
the same `active` as the indexer) embeds the query via the LLM gateway, reads the
tenant's vectors (RLS-scoped), scores cosine over **equal-dimension** rows, drops
non-positive scores, and returns the top-`cap` `{id, score}[]` — **symmetric with
the OpenSearch lane**, so the search service hydrates it through the same path.

### 2. Vector lane fused into `/v1/search` (RRF, dedup → `hybrid`)

`SearchService` resolves the vector lane **before** the request tx (like the
OpenSearch call), hydrates its ids through the **same** `hydrateDocHits` as the
keyword lane — so the **folder-access predicate, RLS, `ready`-only and
`deleted_at` filters apply identically** (permission-aware retrieval) — and adds
it as another list to the fuser. `fuse()` now **sums RRF contributions per
`(type,id)`**: a document that ranks in both the keyword and the vector lane is
**deduped into one hit with a boosted score**, reported as `source: "hybrid"`
(the `SearchSource` contract gained `vector` + `hybrid`). For the disjoint lanes
(incidents, cases, keyword-only docs) the sum is a single term, so the P3.7
behaviour is **unchanged**.

### 3. P5.2 status bug fixed

`reindexAll` filtered `status = "available"`, but documents finalize to
**`ready`** (the live `indexDoc` hook + the search hydrate both use `ready`); the
P5.2 e2e masked it by inserting `'available'` rows. Without the fix, production
reindex would embed nothing and any vector hit would be dropped by the
`ready`-only hydrate. Changed to `ready`; the vector e2e now seeds `ready` docs.

## Consequences

- **Positive:** one search surface (P3.7) gains semantic recall with no new
  service/extension; the vector lane inherits the existing permission-aware
  hydration for free; RRF merges incompatible scales by rank; deduped `hybrid`
  hits are boosted; gated off (no LLM ⇒ no vector lane ⇒ pure keyword), so dev/
  test/CI are unaffected.
- **Negative / trade-offs:** cosine is **brute-force over all tenant vectors per
  query** (no ANN index) — fine at single-site scale, pgvector/Qdrant is the
  follow-on (swaps in behind `similar()` without touching the search service);
  the query embedding is an **inline** call on the search path (adds latency when
  the lane is on); **documents-only** (incident/case embeddings are follow-ons);
  no chunking (name+description vectors; full-content extraction is P5.6); real
  embeddings need a live model server (manual live-smoke).

## Validation

- e2e `search-semantic` **7/7**: pure cosine (identical=1, orthogonal=0,
  dims-mismatch/zero=0, opposite=-1); a semantically-related doc the keyword lane
  misses surfaces via the **vector** lane; a doc matched by both lanes is
  **deduped** to one **hybrid** hit with a boosted score; the vector lane is
  **lifecycle/access filtered** (a soft-deleted nearest-neighbour is dropped);
  and a caller **without `document:read`** gets nothing. Faked provider — no model
  server; OpenSearch left off so the keyword lane is Postgres FTS.
- Full backend suite **65 suites / 458 tests**, zero regressions (the P3.7
  federated tests are unchanged by the RRF refactor); `tsc`/eslint clean.
- **Boundary:** real embeddings via a live OpenAI-compatible endpoint = manual
  live-smoke.

## Files

- `apps/api/src/modules/vector/cosine.ts` (new), `vector-index.service.ts`
  (`similar()` + `reindexAll` status fix)
- `apps/api/src/modules/search/search.service.ts` (vector lane + `hydrateDocHits`
  + per-item RRF), `search.module.ts` (imports `VectorModule`)
- `packages/contracts/src/search.ts` (`vector` + `hybrid` sources)
- `apps/api/test/e2e/search-semantic.e2e-spec.ts` (new); `vector.e2e-spec.ts`
  (`ready` docs)

## Follow-ons

- pgvector ANN index / Qdrant at scale (swaps in behind `similar()`); async
  query-embedding cache.
- Embed + semantically search incidents + cases (after P5.2 follow-on); chunk
  long documents; full-content extraction (P5.6).
- **P5.4** RAG framework (retrieval → context → LLM → citations → audit) builds
  directly on this retrieval.
- Web: surface the `hybrid`/`vector` source badge in the global search UI (P3.7b).
