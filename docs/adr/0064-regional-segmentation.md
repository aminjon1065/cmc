# ADR-0064: Regional segmentation — within-tenant region dimension + hard service-layer scoping

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.6 (a — substrate; b — hard scoping on incidents + cases; c — web + close)
**Supersedes scope of:** the original "P4.6 Multi-region (active-passive DR)"
**Depends on:** RBAC (P1.1), incidents (P1.5), cases (P2.10), admin users (P1.4b), RLS, BFF posture

## Context

The original P4.6 envisioned physical multi-region DR — cross-datacenter logical
replication, regional Tempo+Loki, DNS-level failover. The deployment reality
(stated 2026-06-03) is **single-site**: the server *and* its backups live at the
head office. There is no second site, so physical multi-region DR does not apply.

What is actually needed is **organizational**: divide users and operational data
by **region** (the administrative regions of Tajikistan) for clarity and access
separation — regional staff see only their own region; the head office sees
everything. So P4.6 was reframed from "multi-region DR" to **regional
segmentation**.

(The one DR carry-over: co-locating backups with the server gives no geographic
protection. An **off-site backup** is recorded as a follow-on, not built here.)

## Decision

### 1. Region is a dimension *within* the tenant (P4.6a)

A `regions` table (per-tenant `code`+`name`, unique `(tenant, code)`, RLS,
migration 0039) plus `users.region_id` (FK, on-delete set-null). **Not** a
separate tenant (that would break tenant isolation and force cross-tenant access
for the head office) and **not** a mere label (the requirement is real access
separation). Seeded per-tenant with the TJ regions (Душанбе, Согд, Хатлон, ГБАО,
РРП) and then admin-editable (`ensureDefaultRegionsForTenant`, shared by the dev
seed + e2e fixtures).

### 2. RBAC: `region:*` + a `hq` system role

`region:read` / `region:manage` / `region:all` in the catalog. `region:all`
("head office") grants cross-region visibility. Because functional roles
(operator/auditor) are used by both regional and HQ staff, a dedicated **`hq`
system role** (`region:read` + `region:all`) is layered on top of a user's
functional role to make them head-office; `tenant_admin` gets `region:all` via
`*`. Regional staff get a functional role + a `region_id` assignment, no `hq`.

### 3. Hard scoping enforced in the service layer (P4.6b)

`RegionScopeService.current()` → `{ seeAll, regionId }`:
- `seeAll` when the actor has `region:all`, is an **API-key** principal
  (tenant-level integration, unscoped — preserves P3.9 behaviour), or there is
  **no request context** (cron / event consumer → unscoped, backward-compatible);
- otherwise the actor's own `users.region_id`.

`regionScopeCondition(col, scope)` → `region_id IS NOT DISTINCT FROM $::uuid`
(undefined when `seeAll`). `IS NOT DISTINCT FROM` makes a **null-region** actor
match **null-region** rows — so pre-region data and region-less users keep
working unchanged. Applied to incidents `list`/`getDetail`/`stats` and cases
`list`/`getDetail`/`stats`/`listActivity`/`addComment`. Because the mutation
paths (update/transition/assign/delete) funnel through the scoped `getDetail`,
an out-of-region id is a **clean 404** for both reads and writes. `create`
**stamps the creator's region**.

**Why service-layer, not RLS:** the head-office bypass is *role-dependent*
(`region:all`), which the two-GUC RLS pattern can't express cleanly without
threading permission state into a GUC. Service-layer scoping (the P3.3b
folder-permission precedent) keeps it role-aware, e2e-testable, and leaves the
existing tenant-isolation RLS untouched. The structured `region_id` is kept
**separate** from the incidents free-text `region` label (the latter stays a
descriptive field; consolidating them is a follow-on).

### 4. Web (P4.6c)

`/admin/regions` (CRUD, gated `region:manage`), region assignment on
`/admin/users` (a per-row dropdown → `PATCH /v1/users/:id` `regionId`), and on
incidents a **region (zone) badge** + a **zone filter** (`GET /v1/incidents?regionId=`).
Reads stream through the BFF as everywhere else.

## Consequences

- **Positive:** regional users are cleanly walled to their region; the head
  office sees all; backward-compatible with pre-region data and API keys; tenant
  isolation (RLS) is untouched; the model is a small, well-contained dimension.
- **Negative / trade-offs:** the **monitoring wall** (P4.3, queries incidents
  directly) and **ClickHouse analytics** (P2.6) are **not yet region-scoped**
  (HQ-oriented aggregates — follow-on); incidents carry both a free-text `region`
  and a structured `region_id` (potential future consolidation); **cases have no
  web UI yet**, so the region badge/filter is incidents-only for now; HQ cannot
  yet file an incident *for* a specific region from the UI (create stamps the
  creator's region — region-picker is a follow-on).

## Validation

- e2e `regions` **5/5** (P4.6a) + `region-scoping` **3/3** (P4.6b: create-stamp,
  regional list isolation, HQ-sees-all, cross-region detail/activity 404, cases
  mirror). Full backend suite **59 suites / 424 tests**, zero regressions (rbac
  role-set assertions updated for the new `hq` role).
- `tsc` (api + web) / eslint clean; web `build` green; smoke `/admin/regions`→307.
- **Boundary:** single-site means no geographic DR is testable/implemented here
  (off-site backup = follow-on).

## Files

- Backend: `apps/api/src/modules/regions/` (`regions.service.ts`,
  `regions.controller.ts`, `region-scope.service.ts`, `region-seed.ts`,
  `regions.module.ts`), `packages/db/src/schema/regions.ts` (+ `users.region_id`,
  `incidents.region_id`, `cases.region_id`; migrations 0039 + 0040),
  `packages/contracts/src/region.ts`, `region:*` + `hq` in the RBAC catalog,
  region scoping in `incidents.service.ts` + `cases.service.ts`.
- Web: `apps/web/src/app/admin/regions/`, region assignment in
  `apps/web/src/app/admin/users/`, region badge + zone filter in
  `apps/web/src/app/incidents/`, `apps/web/src/lib/regions.ts`.

## Follow-ons

- Region-scope the monitoring wall + ClickHouse analytics.
- Cases web UI (then region badge/filter there).
- HQ region-picker on incident/case create.
- Consolidate the incidents free-text `region` into structured `region_id`.
- **Off-site backup** (the one DR carry-over from the single-site reality).
