# ADR-0052: Federated `/v1/search` (OpenSearch + Postgres FTS, RRF) + web UI

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.7 (a: federated backend; b: web UI)
**Depends on:** Postgres FTS search (P2.11 / ADR-0041), OpenSearch document search (P3.6 / ADR-0051), folder access (P3.3b / ADR-0048), RBAC (P1.1)

## Context

P2.11 gave `/v1/search` as cross-domain Postgres FTS over incidents/cases/
documents. P3.6 added OpenSearch for documents (better relevance). P3.7 unifies
them: one endpoint that uses OpenSearch for documents (when enabled) and FTS for
the transactional domains, merged into a single ranked list, plus a web UI.
Three points were confirmed with the user: **Reciprocal Rank Fusion** for
merging, **defer ClickHouse facets**, and **backend + web UI** (a/b).

Two sub-problems drove the design:
1. **Incompatible score scales.** OpenSearch BM25 (unbounded, ~1–20) and Postgres
   `ts_rank` (~0–1) can't be compared by raw value — whichever emits bigger
   numbers would dominate.
2. **A latent access leak.** The original P2.11 documents sub-query filtered only
   by `deleted_at` + RLS — *not* by folder access. So `/v1/search` could surface
   the name/snippet of a document in a restricted folder (P3.3b) to a user who
   couldn't otherwise read it.

## Decision

### Fan-out (P3.7a)

`SearchService` resolves the caller's permissions and queries each readable
domain, RLS-scoped in the request tx:
- **incidents, cases** → Postgres `websearch_to_tsquery` + `ts_rank` (P2.11).
- **documents** → OpenSearch (`multi_match name^2/description`, `term tenantId`)
  when `SEARCH_INDEX.active`; otherwise Postgres FTS. **Both** paths now apply
  `FolderAccessService.documentListCondition` + `status='ready'`, closing the
  leak. The OpenSearch path hydrates hit ids in one access-filtered, RLS-scoped
  query (so restricted-subtree docs and any stray cross-tenant id drop out),
  then restores the OpenSearch order.

### Merge: Reciprocal Rank Fusion

Each domain returns an independently-ranked list. A hit's fused score is
`1/(k + rank)` (1-based rank within its domain, `k = 60`). The merged list sorts
by fused score, breaking ties by raw score then id for determinism. Because the
domains are disjoint, every item contributes exactly one RRF term — this is
effectively a rank-interleave that's blind to the raw BM25-vs-`ts_rank` scale
mismatch. `SearchResult` gains `source: "opensearch" | "postgres"` so callers
(and the UI) can see which engine served each row.

### Web UI (P3.7b)

`/search` — a server component reading `?q=` and calling `/v1/search` via the
server-only `authedApiFetch`, with a client `SearchBox` that pushes the query
into the URL. Results are grouped by type (Incidents / Cases / Documents) with a
per-row source badge; incidents link to their detail page, documents to the
documents list (no per-doc page yet), cases render without a link. The sidebar
"Search" entry is enabled and `/search` is added to the auth-protected matcher in
middleware.

## Consequences

**Positive**
- One endpoint, one ranked list spanning OpenSearch + Postgres, with relevance
  that doesn't collapse to whichever engine emits bigger numbers.
- The P2.11 folder-access leak is closed — federated search now obeys the same
  per-folder rules as the document list (P3.3b), enforced in SQL + RLS.
- `source` makes the hybrid observable; the UI degrades gracefully (Postgres
  fallback) when OpenSearch is disabled.
- RRF needs no per-source tuning and adding a future source (messages, wiki) is
  just another ranked list in the fusion.

**Negative / deferred**
- **RRF ignores raw score magnitude** — a strongly-relevant #1 and a weak #1 in
  another domain tie at rank 1. Acceptable for cross-domain discovery; a
  per-source weight is a future option if one domain should outrank another.
- **ClickHouse-aggregated facets deferred** (confirmed) — counts/time facets are
  a later item; CH currently holds incident/audit data, not doc metadata.
- **No highlighting** (`ts_headline` / OpenSearch highlight), stemming, fuzzy, or
  per-language analysis yet; documents-only for the OpenSearch path.
- UI links are thin where detail pages don't exist (cases, per-document).

## Validation

- **API suite**: 336/336, 45 suites (+4 over P3.6). `search-federated.e2e`
  (faked seam): OpenSearch documents + FTS incidents merged with correct
  `source` flags + non-increasing RRF; **restricted-folder document hidden from a
  non-grantee** (admin bypasses); FTS fallback when the index is off (still
  folder-filtered); no documents without `document:read`. The original
  `search.e2e` (6) stays green (RRF scores > 0, non-increasing).
- **API live smoke** (`search-federated.live-smoke.ts`, real OpenSearch): a
  finalized upload is indexed (P3.6a) and returned by `/v1/search`
  `source=opensearch`, fused with an FTS incident `source=postgres`;
  `/v1/documents/search` reports `backend=opensearch`.
- **Web**: `next lint` + `next build` clean (`/search` route built). Runtime
  smoke: `/search?q=…` unauthenticated → 307 → `/login?next=…` (middleware
  protection live), `/login` → 200.
- **Build/lint**: contracts + API `tsc`, `nest build`, `eslint` clean.
