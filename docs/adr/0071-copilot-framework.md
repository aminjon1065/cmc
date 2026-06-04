# ADR-0071: Per-module copilots — read-only, module-scoped, record-anchored assistant over a unified endpoint

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.5 (per-module copilots) — fifth AI item of Horizon P5
**Builds on:** RAG framework (P5.4 / ADR-0070), semantic search (P5.3 / ADR-0069), LLM gateway (P5.1 / ADR-0067), incidents (P1.5), RBAC (P1.1)

## Context

The plan calls for copilots in **GIS, Documents, Workflow, Incidents**. With the
RAG compose (P5.4) and permission-aware hybrid retrieval (P5.3) in place, a
"copilot" is a **module-scoped** RAG: it grounds in *one* module's data, can be
**anchored on a specific record** ("summarize THIS incident"), and speaks with a
module-appropriate persona.

Four forks were locked with the user:
1. **Capability:** **read-only advisory** (no mutations) — safe for a sovereign
   crisis platform; tool-calling/actions are a follow-on.
2. **Scope of this item:** a **copilot framework + the Incidents copilot first**
   (highest value for an EOC); GIS / documents / workflow are follow-ons behind
   the same surface.
3. **Grounding:** **module-scoped RAG + an optional `resourceId` record anchor**.
4. **Surface:** a **unified `POST /v1/copilot/ask`** with a `module` param, not
   per-module endpoints.

## Decision

A copilot is a **composition seam — no new model, store, migration, or
permission.**

### `CopilotService.ask` (per-module registry)

A `modules` registry maps each `CopilotModule` to `{ readPermission, domainTypes,
systemPrompt, loadAnchor }`. The first entry, `incidents`: `incident:read`,
domain `["incident"]`, an EOC-operator persona, and an anchor loader using the
existing access-checked `IncidentsService.getDetail` (region + RLS scoped).

Flow: 503 if the LLM provider is inactive → resolve the caller's perms; **a
caller with `llm:use` but without the module's read permission gets an honest
no-answer** (no data to ground in → never a leak) → optional `resourceId` anchor
(pinned first, loaded only if accessible) → module-scoped retrieval via
`SearchService` filtered to `domainTypes` → merge+dedupe (anchor first) → shared
`assembleContext` (P5.4 grounding helpers) → if no sources, honest no-answer with
**no LLM call** → else generate via `LlmService.complete` (inherits per-tenant
rate-limit, 502 mapping, `llm.complete` audit) with the module's strict-grounding
prompt at `temperature 0` → `resolveCitations` → **`copilot.ask` audit**:
`module`, optional `anchorResourceId`, cited source ids (provenance), counts,
usage; raw question/answer only under `LLM_LOG_PROMPTS`; failure durable.

### Shared grounding helpers (DRY with RAG)

`assembleContext` + `resolveCitations` were extracted from `RagService` into
`rag/grounding.ts` (pure, `GroundingSource`); both RAG and the copilot use them,
so context-building + `[n]` citation resolution are identical (the RAG e2e
re-confirms `RagService` after the refactor).

### Endpoint + contracts

`POST /v1/copilot/ask` (`@Authorize llm:use`, Zod→400) → `{answer, citations[],
grounded, model, usage}`. Contracts `copilot.ts` (`COPILOT_MODULES=["incidents"]`,
citations reuse `RagCitationSchema`). Reuses `RAG_TOP_K` + `RAG_CONTEXT_CHAR_BUDGET`
config. No new permission, role, or migration.

## Consequences

- **Positive:** zero new infrastructure — inherits gating, rate-limit, audit,
  strict grounding, and permission-aware retrieval; the registry makes adding
  GIS/documents/workflow copilots a small follow-on; the read-perm gate +
  permission-filtered retrieval mean a copilot can only surface data the caller
  may already read; the record anchor enables "explain this record" without a
  keyword match.
- **Negative / trade-offs:** **read-only** (no actions/tool-calling yet);
  **incidents-only** for now (other modules are follow-ons); context is
  `title + snippet` (documents need P5.6 extraction for depth); synchronous (no
  streaming); the no-source path isn't rate-limited (no LLM call); real answers
  need a live model server (manual live-smoke).

## Validation

- e2e `copilot` **7/7**: module-scoped grounding + `[n]`→incident-id citation;
  the `resourceId` anchor surfaces a record even when the query doesn't
  keyword-match; **`llm:use` without `incident:read` → honest no-answer, no LLM
  call** (no leak); metadata-only `copilot.ask` audit (module + cited ids, raw
  question sentinel absent); 403 without `llm:use`; 400 on empty question /
  unknown module; 503 when the gateway is disabled. Faked provider; real
  permission-aware retrieval.
- Backend suite is **67 suites / 471 tests**; **all AI suites green** (copilot
  7/7, rag 6/6 — confirming the `grounding` extraction, search-semantic 7/7,
  vector 4/4), `tsc`/eslint clean. The clean full-green flush was captured at
  P5.4 (66/464, exit 0); the P5.5 serial full run reported 65/67 (459/471) where
  the **only** two failures were pre-existing, unrelated suites
  (`rate-limit`, `documents-search-index`) whose `beforeAll`/suite hooks **timed
  out at 153s / 900s** — host resource exhaustion from many back-to-back local
  runs, not assertion failures (both are green on a healthy host). No AI-code
  regression.
- **Boundary:** real generation via a live OpenAI-compatible endpoint = manual
  live-smoke.

## Files

- `apps/api/src/modules/copilot/` (`copilot.service.ts`, `copilot.controller.ts`,
  `copilot.module.ts`); `apps/api/src/modules/rag/grounding.ts` (new, shared);
  `RagService` refactored to use it; `packages/contracts/src/copilot.ts`;
  `app.module.ts` wiring; `apps/api/test/e2e/copilot.e2e-spec.ts`.

## Follow-ons

- GIS / documents / workflow copilots (add registry entries + anchor loaders).
- Action-capable copilots (tool-calling with confirmation + per-tool RBAC).
- Web copilot panels per module (incident detail "ask the copilot", with
  rendered citations); SSE streaming; copilot-specific rate limit.
