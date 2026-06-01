# ADR-0023: Incidents module

**Status:** Accepted (P1.5 complete — all three phases a–c shipped 2026-06-01)
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.5
**Depends on:** ADR-0003 (RLS), ADR-0019 (RBAC)
**Unblocks:** the dashboard's real data (P1.5c), notifications (P1.6)

## Context

Incidents are the platform's reason to exist — the dashboard's "Priority
Incidents", "by region/type", and severity KPIs are all hardcoded copy today.
P1.5 adds the first operational domain module: a real `incidents` table with a
lifecycle, CRUD, assignment, and per-action permissions, so the dashboard can
read live data (P1.5c). This is the first new domain since Documents, so it
sets the pattern subsequent modules (cases, tasks…) will follow.

## Decision

### 1. Severity 1..5 (1 = most severe), free-text region/type/source

`severity` is a `smallint` with a DB `CHECK (1..5)` plus zod `min(1).max(5)` —
"SEV-1" is the most severe, matching the dashboard. `region`, `type`, and
`source` are **free-text varchars**, NOT a DB enum or lookup. Tajikistan's
regions (Khatlon, GBAO, …) and disaster types (Flood, Mudflow, …) are
jurisdiction-specific, and baking them into the schema/code would repeat the
mistake branding (P0.11) fixed. The web offers them as datalist suggestions; a
new region/type needs no migration. (A tenant-configurable catalog can come
later without a breaking change.)

### 2. Status state machine, shared API↔web

The lifecycle is `reported → triaged → in_progress → resolved → closed`, with
`cancelled` reachable from any active state and a reopen edge
(`resolved`/`closed → in_progress`). The transition map `INCIDENT_TRANSITIONS`
lives in `@cmc/contracts` as the single source of truth: the service validates
a requested edge against it (illegal jump → 400), and the web will show only
reachable next states. Resolving stamps `resolved_at`; reopening clears it.

### 3. Six granular permissions; resolve gated above write

`incident:read | create | write | assign | resolve | delete`. Most transitions
(triage, start, cancel, reopen) need `incident:write`; **resolving/closing
additionally requires `incident:resolve`** — enforced inline in the controller
(`rbac.enforce(["incident:resolve"])`) since a single transition route can
target either tier. Deletion is its own `incident:delete`. System-role grants:
`operator` gets read/create/write/assign/resolve (the responder set, **not**
delete); `auditor` gets read; `tenant_admin` gets all via `*`. Adding these to
the catalog means existing tenants need a re-seed (idempotent) — same
catalog-change note as ADR-0022.

### 4. Geolocation: optional lat/lng now, PostGIS later

Optional `latitude`/`longitude` (`numeric(9,6)`) give a map pin without taking
on PostGIS in this module — even though the extension IS installed. Full
geometry (polygons, spatial queries, GiST) belongs to the GIS module (ToR
§3.4), which can add a `geometry` column alongside these. postgres-js returns
`numeric` as a string, so the service converts at the boundary (number in the
API, string in the column).

### 5. Soft-delete + audit on every mutation

`deleted_at` soft-deletes (list/detail filter it out → 404 after delete).
Every mutation audits: `incident.created`, `incident.updated`,
`incident.transitioned` (metadata `{from, to, note}`), `incident.assigned`,
`incident.deleted`. Reads aren't audited (volume).

### 6. List + stats

`GET /incidents` filters on status/severity/region/type/assignedTo + a summary
`ilike` search, with `limit`/`offset` pagination (default 50, max 200) and a
`total` count, ordered by `occurred_at` desc. Reporter/assignee names are
attached by collecting the ids and one `IN` lookup (no aliased self-joins).
`GET /incidents/stats` aggregates **active** incidents (reported/triaged/
in_progress) by severity/region/type for the dashboard — declared before the
`:id` route so "stats" isn't captured by the UUID param.

## P1.5b — Web `/incidents` (delivered 2026-06-01)

The first user-visible domain UI, on the established server-component +
server-action pattern.

- **List** (`/incidents`): a filter bar (status/severity/region/type + summary
  search) that drives URL query params (shareable/bookmarkable), a paginated
  table (severity + status badges, summary→detail link, region/type/assignee/
  occurred), and a collapsible "Report incident" form shown only to
  `incident:create`. Gated softly — the page shows a permission message if the
  API 403s; the nav entry is hidden without `incident:read`.
- **Detail** (`/incidents/[id]`): full incident + an Actions panel that is
  **state-machine-aware** — it offers only the statuses reachable from the
  current one (`INCIDENT_TRANSITIONS`), and hides resolving targets
  (resolved/closed) when the user lacks `incident:resolve` (the API would 403
  anyway). Assign uses a member dropdown; edit is an inline form; delete is
  gated on `incident:delete`. Each control is shown per the user's permissions
  (`getMyAccess`), but the API remains the real boundary.
- **Assignee directory:** a new `GET /incidents/assignees` (gated
  `incident:assign`) returns active tenant members `{id, name}` — needed because
  the full user list is `user:manage`-gated, which a responder who can assign
  incidents doesn't have. Declared before the `:id` route.
- **Suggestions in the web, not the API:** region/type/source datalists
  (Tajikistan regions, disaster types) live in `lib/incident-suggestions.ts` —
  UI hints over the free-text fields, keeping jurisdiction specifics out of the
  backend (ADR-0023 §1).
- **Validated:** the assignees endpoint adds 1 e2e (suite **152/152**); web
  typecheck + production build green (`/incidents` + `/incidents/[id]` compile)
  + lint clean.

## P1.5c — Dashboard on real data (delivered 2026-06-01)

The dashboard's incident widgets, previously hardcoded arrays, now read the
API.

- **New `active` list filter** (`GET /incidents?active=true`) → status ∈
  {reported, triaged, in_progress}, sharing the `ACTIVE_STATUSES` set with the
  stats query. The dashboard's Priority panel uses it; the operator list can
  too.
- **Wired widgets:** the hero ribbon (alert level + active/SEV-1/SEV-2/region
  counts), the KPI strip (Active / SEV-1 / SEV-2 / SEV-3 / Regions / Types),
  "Active by Region" + "Active by Type" bars, and "Priority Incidents" (real
  active incidents, **most-severe-first**, linking to the detail page) all read
  `GET /incidents/stats` + `GET /incidents?active=true`. The hardcoded
  `REGIONS`/`INCIDENT_TYPES`/`PRIORITY` arrays are gone.
- **Fail-safe:** both fetches degrade to empty/zero on error (e.g. a viewer
  without `incident:read`), so the dashboard never errors — it just shows zeros
  + an "(incident data unavailable)" note.
- **Validated:** +1 e2e for the active filter (suite **153/153**); web build +
  lint green; live-smoke seeded a SEV-1..4 spread across regions/types (plus a
  resolved one) and confirmed `stats` (activeTotal 5, the resolved excluded;
  bySeverity/byRegion/byType correct) and the severity-sorted active list — the
  exact data the dashboard renders.

## P1.5 complete

All three phases shipped: **a** backend domain · **b** operator UI · **c**
live dashboard. The platform's headline screen now reflects real incidents, and
operators can run the full report→triage→assign→resolve loop. The deferred
items (geometry/GIS, SLA, activity timeline, command roles, analytics) are
tracked in §3.27 of the tracker.

## Consequences

**Positive:**

- The first real domain module: incidents have a lifecycle, ownership, and
  least-privilege permissions, all tenant-isolated by RLS and audited.
- The dashboard is no longer a mockup — its incident widgets read live data.
- A working operator UI: report → triage → assign → resolve, end to end.
- The shared transition map means the web can't offer an edge the API will
  reject — no drift.
- The shared transition map means the web can't offer an edge the API will
  reject — no drift.
- Free-text categoricals keep jurisdiction specifics out of the schema, so the
  same code serves any tenant.
- Verified: 11 e2e (create/list+filters/detail/update/lifecycle+illegal-jump/
  resolve-gate/assign+cross-tenant/auditor-RO/operator-no-delete/cross-tenant/
  stats); full suite **151/151**; live-smoke of the full lifecycle on the dev
  DB.

**Negative / known gaps:**

- **No real geometry** — lat/lng only; polygons + spatial queries await the GIS
  module.
- **Free-text region/type** can drift (typos split a region's count). A
  tenant-configurable catalog with validation is future work.
- **No notifications** — creating/assigning an incident notifies no one yet
  (P1.6 wires `IncidentsService` → notifications).
- **No SLA/auto-escalation** — severity doesn't drive timers or auto-transitions
  yet.
- **Transition note isn't persisted as a timeline** — it's audit metadata only;
  a per-incident activity feed is future work.

## Triggers for re-evaluation

- GIS module → add a `geometry(Point/Polygon, 4326)` column + GiST index
  alongside lat/lng; backfill from lat/lng.
- P1.6 notifications → emit an event on create/assign/transition.
- Tenants want governed categoricals → a `incident_categories` lookup
  (tenant-scoped) replacing free text, with a migration that preserves values.

## References

- [PRIORITY_EXECUTION_PLAN P1.5](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0019](./0019-rbac.md) — permission model + `@Authorize`
- [ADR-0022](./0022-admin-panel.md) — catalog-change re-seed note reused
- ToR §3.27 (Incident / Event Management), §3.4 (GIS)
