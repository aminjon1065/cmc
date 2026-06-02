# ADR-0041: Cross-domain Postgres FTS search

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.11
**Depends on:** ADR-0023 (incidents), ADR-0040 (cases), documents (P0.10)

## Context

Users need to find things across domains without a dedicated search cluster.
OpenSearch is Phase-3; P2.11 is the **interim**: full-text search built on
Postgres `tsvector`, fanned out across incidents, cases, and documents.

## Decision

### GIN expression indexes per domain

A GIN index over a `to_tsvector('simple', …)` expression on each searchable
table (migration 0020):

- incidents: `summary || description || type || region`
- cases: `title || description || type`
- documents: `name || description`

The query uses the **identical** expression with `@@`, so it's index-backed.

### `simple` config (language-neutral)

The text-search config is `'simple'` (lowercase + tokenise, **no stemming, no
stop-words**) rather than `'english'`. The platform's content is multilingual
(Tajik/Russian/English); English stemming would mangle non-English tokens.
`simple` is predictable across languages. Per-language configs are a later
refinement.

### `/v1/search` fans out + merges

`GET /v1/search?q=…` (authenticated; **no single permission gate**). The service
resolves the caller's permissions and queries only the domains they can read
(`incident:read` / `case:read` / `document:read`); each query runs in the request
tenant tx so **RLS** confines it to the tenant. Per domain it runs
`websearch_to_tsquery('simple', q)` (handles quotes/`OR`/`-` from user input),
scores with `ts_rank`, takes the top N, and returns a uniform `SearchResult`
(`type`, `id`, `title`, plain-text `snippet`, `score`). Results from all domains
are merged and sorted by score. `sql.raw` is used only for the fixed
table/column/expression constants; the user's `q` is always a bound parameter.

## Consequences

**Positive**
- Cross-domain search with zero new infrastructure; index-backed; tenant-isolated
  + permission-filtered for free.
- `websearch_to_tsquery` gives users familiar query syntax safely.
- Verified live: `flood` → 4 results across incidents + a case, ranked by score;
  the specific term `zarafshan` → exactly the one matching incident.

**Negative / deferred**
- **No stemming / fuzzy / typo-tolerance / per-language configs** (`simple` is
  exact-token) — OpenSearch territory (Phase-3).
- **No highlight snippets** — `snippet` is a plain truncation (no `ts_headline`),
  to avoid returning markup; client can highlight.
- **Per-domain top-N then merge** — global ranking is approximate when a domain
  has many hits beyond N (fine at this scale).
- Only incidents/cases/documents are indexed; new domains must opt in (index +
  a `DOMAINS` entry).

## Validation

- **Suite**: 267/267, 34 suites. `search` (6): cross-domain match ranked by
  score; no-match term → empty; **RBAC** (role-less → empty); blank query →
  empty; **tenant isolation** (RLS); 401 unauth.
- **Live smoke** (booted API): seed an incident + case + document with "flood";
  `?q=flood` → 4 ranked cross-domain results; `?q=zarafshan` → 1 incident.
- **Migration**: 0020 (GIN FTS indexes) applied to dev + `cmc_test`.
  **Build/lint**: API `tsc`/`nest build`/`eslint` + db + contracts clean.
