# ADR-0051: OpenSearch document indexing + permission-aware search

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.6 (a: substrate + indexer; b: search query)
**Depends on:** documents (P0.10), folders + access (P3.3 / ADR-0047,0048), RBAC (P1.1), the gated-seam pattern (ClickHouse P2.5 / ADR-0033), `@opensearch-project/opensearch`

## Context

ToR §5.1 / §3.14 call for a real search engine. The interim is cross-domain
Postgres FTS (P2.11 / ADR-0041) — fine for substring/`tsvector` queries but
without relevance tuning, stemming, or fuzzy matching. P3.6 introduces
OpenSearch as the document search substrate (P3.7 will federate it into
`/v1/search` alongside FTS + ClickHouse). Three points were confirmed with the
user: **documents only** (incidents/cases stay on FTS for now), **direct
best-effort indexing from the service** (no outbox/queue), and search results
**post-filtered through folder access**.

## Decision

### Gated-lazy seam (same shape as ClickHouse)

`SEARCH_INDEX` DI token + `SearchIndex` interface (`ensureIndex` / `indexDocument`
/ `deleteDocument` / `search` / `ping` / `close`). `NoopSearchIndex` is the
default; `createSearchIndex` is an async factory that **dynamic-imports**
`RealSearchIndex` (the `@opensearch-project/opensearch` driver) only when
`OPENSEARCH_ENABLED`. So the driver never enters the jest runtime — tests
override the token with a fake. `SearchIndexBootstrap` (`OnModuleInit`) creates
the `cmc-documents` index + mapping (keyword for `tenantId`/`mimeType`/`folderId`/
`status`, text for `name`/`description`, date for timestamps) at boot when active.
Writes use `refresh: true` (read-your-writes; a prod tuning could relax it).

### Indexing: best-effort, on the write path (P3.6a)

`DocumentsService` injects `SEARCH_INDEX`. `indexDoc`/`unindexDoc` wrap the seam
in try/catch → `logger.warn` and **never throw** — search is non-critical, so a
down index must not break uploads. They are called on every state change that
affects a searchable field: finalize, multipart-complete, version-finalize,
version-restore, move (index) and soft-delete (unindex). `reindex()`
(`POST /v1/documents/reindex`, `document:write`) backfills all ready, non-deleted
documents in the tenant — for enabling the index after data already exists, or
after a mapping change. No-op (count 0) when the index is the noop.

### Search: post-filter via folder access (P3.6b)

`searchDocuments(query, limit)` →
1. If the index is inactive, **fall back** to the Postgres `list({ q })` (ILIKE +
   the same access filter); `backend: "postgres"`.
2. Otherwise query OpenSearch (`multi_match` on `name^2` + `description`, filtered
   by `term tenantId`), returning hits `{ id, folderId, score }` in relevance
   order; `backend: "opensearch"`.
3. **Post-filter + hydrate**: fetch the hit ids from Postgres in **one
   RLS-scoped query** that also applies `FolderAccessService.documentListCondition`
   — the *exact* predicate the document list uses (P3.3b). So docs in a restricted
   subtree the caller can't read drop out, and any stray cross-tenant id drops out
   via RLS. The fetched rows are re-sorted into the OpenSearch score order.

`GET /v1/documents/search?q=&limit=` (`document:read`) is declared **before**
`@Get(":id")` so the literal path isn't captured by the UUID route; empty `q` →
400. `DocumentSearchResponse` = `{ documents, backend }`.

Post-filtering (vs. pushing the user's grants into the OpenSearch query) keeps the
index identity-agnostic — it stores only `tenantId`, never per-user ACLs, so a
grant/restrict change needs no reindex. The cost is fetching up to `limit` ids
that may then be filtered; acceptable at this `limit` (≤100).

## Consequences

**Positive**
- Relevance-ranked document search (name boosted over description) with stemming/
  fuzzy/highlighting now reachable via OpenSearch config — without touching the
  write path's correctness (indexing is best-effort).
- One access rule, one place: search reuses `documentListCondition`, so list and
  search can never diverge on what a user may see. RLS is the backstop.
- Off by default (`OPENSEARCH_ENABLED=false`) → the endpoint transparently falls
  back to Postgres; no behavioural cliff when the cluster is absent.
- The index holds no per-user data → grant/restrict changes need no reindex.

**Negative / deferred**
- **Documents only.** Incidents/cases/messages stay on Postgres FTS until P3.7
  federates them.
- **Best-effort indexing can drift** from Postgres on a transient OpenSearch
  outage (a warn is logged); `reindex` is the manual reconciliation. A
  durable/outbox-driven indexer is a follow-on if drift matters.
- **Post-filter, not pre-filter** — a query whose top-`limit` hits are mostly
  inaccessible returns fewer than `limit` rows (no back-fill pass). Fine for now.
- **DEV security off**: the compose container runs with the security plugin
  disabled (`DISABLE_SECURITY_PLUGIN=true`) — dev only; prod needs TLS + auth.
- No content extraction (Tika/OCR) — only `name` + `description` are indexed.

## Validation

- **Suite**: 332/332, 44 suites (+12 over P3.5). Real Postgres + Redis + MinIO;
  OpenSearch faked via the seam.
  - `documents-search-index` (P3.6a): indexes on finalize, unindexes on delete,
    re-indexes on move, `reindex` reports the count + skips non-ready, **indexing
    failures don't break the write path**.
  - `documents-search` (P3.6b): hydration preserves OpenSearch relevance order;
    restricted-folder docs filtered out for a non-grantee (admin bypasses; a grant
    unlocks); cross-tenant id dropped by RLS hydration; Postgres fallback when the
    index is disabled; empty `q` → 400; `document:read` enforced.
- **Live smoke** (real OpenSearch 2.17.1):
  - P3.6a: `ensureIndex` idempotent, ping, index → search by name + description,
    tenant isolation, delete + 404-swallow.
  - P3.6b: real ranking (name^2 outranks description-only), non-match excluded,
    cross-tenant match excluded, scores descending, tenant B sees only its own.
- **Build/lint**: contracts + API `tsc`, `nest build`, `eslint` clean. New dep
  `@opensearch-project/opensearch`; `opensearch` compose service + volume;
  `OPENSEARCH_ENABLED` / `OPENSEARCH_URL` / `OPENSEARCH_INDEX_PREFIX` config.
