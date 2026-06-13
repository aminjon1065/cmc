# CMC — Implementation Plan

Single source of truth for **build order**. Scope is defined by
[`ToR.md`](./ToR.md). This plan sequences the in-scope work and tracks progress.
Most modules already exist in code but were built multi-tenant and against the
old maximal ToR; the early phases therefore **reduce, verify, and complete**
rather than build from zero.

## How to use this file

- Work **one phase at a time, top to bottom**. Do not start a phase whose
  dependencies are unchecked.
- Tick a box only when its **done-criteria** are met and the build + tests are
  green.
- Every architectural decision → an ADR. Every removed capability → its ADR
  marked `Superseded`.
- **No scope creep.** If a task is not in `ToR.md` §5 (in-scope), it does not get
  built. Items in `ToR.md` §2/§12 stay out until their trigger is met.

**Status:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## Cross-cutting invariants (hold at every commit)

- [ ] Build, typecheck, lint, and tests are green before each commit.
- [ ] Commits are small and atomic; conventional commit messages.
- [ ] Destructive operations (dropping tables/columns, deleting data) are done via
      reversible migrations and only after backup; never silently.
- [ ] No `tenant_id`, no tenant context, no tenant RLS anywhere after Phase 0.
- [ ] Every read/write path enforces RBAC and (where applicable) region scope.
- [ ] Every state-mutating action writes an audit entry.

---

## Phase 0 — Scope reduction *(do this first)*

**Goal:** bring the live repository in line with `ToR.md` v2.0 — remove
multi-tenancy and all §2 non-goal modules, swap NATS for in-process events, defer
ClickHouse, prune docs.

- [x] Read `ToR.md` and this plan in full. Produce a module/ADR inventory mapping
      each existing module and ADR to **KEEP / REMOVE / DEFER** per `ToR.md`.
- [x] Write **ADR-0080: Scope reduction to single-organization КЧС deployment**
      recording: removal of multi-tenancy; removal/deferral of Temporal, NATS,
      ClickHouse, the AI stack, video/media, collaborative editing, OpenSearch,
      visual workflow builder, wiki, API keys, PWA, SOC2 program, heavy
      observability. Mark every superseded ADR `Superseded by ADR-0080`.
- [x] **Remove non-goal modules** (one module per commit, build green each time):
      `temporal`, `workflows` (Temporal-backed), `vector`, `rag`, `copilot`,
      `llm`, `collab`, `video`, `media`, `api-keys`, `wiki`, `monitoring`, plus
      the OpenSearch/federated-search, AI document-intelligence/extraction, and
      visual-workflow-builder paths. `previews` was **kept** (document
      thumbnails, not AV-only). `documents` + `search` reworked to Postgres-FTS
      only; `incidents` + `cases` unwired from the Temporal SLA schedulers.
      Drop migration 0044 removes the 13 descoped tables. Full e2e suite green
      (366/366) on a fresh-migrated DB.
- [x] **Defer ClickHouse:** point `analytics` at PostgreSQL; remove the ClickHouse
      client wiring and its compose service; keep the projection pattern
      documented for later (ADR note, not code). Dashboard repointed to Postgres;
      anomaly/projection planes removed; full e2e green (47 suites / 348 tests).
- [x] **Swap NATS → in-process events** (Nest `EventEmitter`); keep outbox code
      but off by default; remove NATS from compose. Domain events carry the
      in-tx detail so @OnEvent listeners (notifications, realtime fan-out) never
      re-fetch in a separate tx; full e2e green (47 suites / 346 tests).
- [ ] **Remove multi-tenancy** *(highest-risk step — do incrementally, tests green
      after each sub-step)*:
  - [ ] Drop `tenants` and `tenant-branding` modules + schema.
  - [ ] Migration: remove `tenant_id` columns and tenant RLS policies across all
        kept tables.
  - [ ] Replace `TenantContext` / `TenantDatabaseService` with a simpler request
        context; make **regions** the primary org-scoping dimension.
  - [ ] Update auth (ADR-0002) to drop tenant claims from tokens/sessions.
  - [ ] Re-point RBAC roles from per-tenant to organization-global; reseed system
        roles + permission catalog once.
- [ ] **Prune docs:** remove `docs/compliance` (SOC2 N/A) and airgap/sovereign
      runbooks; trim `docs/audit/*` to match real scope; update `README.md`
      architecture section and module list.
- [ ] Full `typecheck` + `lint` + `build` + `test` green; seed script runs;
      migrations apply end-to-end on a fresh DB.

**Done when:** repository contains only `ToR.md` §5 modules, no tenant concept
remains, the app boots on Docker Compose, and CI is green.

---

## Phase 1 — Foundation hardening
**Depends on:** Phase 0

- [ ] Verify auth (login/refresh/logout), sessions, MFA (TOTP), password reset
      post-descope.
- [ ] Verify RBAC end to end: permission catalog seeded, roles, role-permissions,
      user-roles; guard enforces `(domain, action)` at the API boundary.
- [ ] Verify region scope: regional users confined to their region; `region:all`
      sees all; new rows stamped with actor region.
- [ ] Seed: КЧС organizational roles + permission catalog + administrative regions
      of Tajikistan.
- [ ] Audit log + hash chain verified; file export works.

**Done when:** an admin can manage users/roles/regions and every protected
endpoint enforces RBAC + region scope, with audit entries written.

---

## Phase 2 — Operational domain (incidents & cases)
**Depends on:** Phase 1

- [ ] Incidents: state machine, severity, assignment, region scope verified
      post-descope; in-app notifications fire (no NATS).
- [ ] Cases: lifecycle, activity log, transitions verified.
- [ ] **Rebuild incident-response + case-SLA escalation as in-app scheduled jobs**
      (`@nestjs/schedule`, DB state) — replaces the Temporal schedulers removed in
      Phase 0 (ADR-0080 / ToR §6).
- [ ] Web UI for incident and case lists/detail with server-side
      filtering/sorting/pagination.

**Done when:** staff can report, assign, transition, and track incidents and cases
through the web UI.

---

## Phase 3 — Tasks / board + delegation *(new build)*
**Depends on:** Phase 1 (RBAC hierarchy), Phase 2 (domain patterns)

> Not present in current code. Build it.

- [ ] Data model: boards, columns, tasks, assignees, due dates, priority, links to
      incidents/cases/documents.
- [ ] **Delegation along the role hierarchy** (chief → subordinate) within a
      department, enforced by RBAC + hierarchy.
- [ ] Kanban-style board UI (Jira/Trello-like) with drag-and-drop; task detail.
- [ ] Notifications on assignment/transition; audit on changes.

**Done when:** a chief can create and delegate tasks down their hierarchy and track
them on a board.

---

## Phase 4 — Documents / EDMS (СЭД)
**Depends on:** Phase 1

- [ ] Documents: lifecycle states, metadata, **versioning**, **retention & legal
      hold** verified; content in MinIO, metadata + state in Postgres.
- [ ] Folders: ltree tree + permission inheritance verified.
- [ ] Imports: CSV/Excel import with validation + row-error reporting.
- [ ] Web UI: file manager (tree + list), document detail, version history,
      upload (resumable/multipart).

**Done when:** users can file, version, retain, and find documents through the web
UI, with permissions inherited down the folder tree.

---

## Phase 5 — Spatial / GIS
**Depends on:** Phase 1

- [ ] PostGIS layers + features CRUD; spatial queries; region scope on features.
- [ ] Vector tile server serving layers as vector tiles.
- [ ] GeoServer / OGC (WMS/WFS/WMTS) endpoints published.
- [ ] **Verify QGIS and ArcGIS connect** to authoritative layers via OGC.
- [ ] MapLibre GL web map consuming vector tiles (no raw geometry on the wire).

**Done when:** analysts manage layers in the web map and external QGIS/ArcGIS
clients read the same authoritative layers.

---

## Phase 6 — Discovery (search)
**Depends on:** Phases 2, 4 (objects to index)

- [ ] PostgreSQL FTS indexes across documents, incidents, cases, tasks.
- [ ] Search API with region/RBAC filtering; result ranking.
- [ ] Web search UI with filters.

**Done when:** a user finds any object they are authorized to see via one search.

---

## Phase 7 — Analytics & reporting
**Depends on:** Phases 2, 4, 5

- [ ] Operational dashboards computed from **PostgreSQL** (incident trends, case
      throughput, regional breakdowns).
- [ ] Report builder/export to PDF/XLSX via background queue.
- [ ] Scheduled report delivery (in-app/email).

**Done when:** analysts build, view, and export reports/dashboards without raw SQL,
and heavy reports run as background jobs.

---

## Phase 8 — Communication
**Depends on:** Phase 1

- [ ] Realtime WebSocket gateway (auth + presence + live updates), Redis fan-out.
- [ ] Chat MVP: channels + DMs, message persistence, platform-object links.
- [ ] Notifications surfaced in-app in real time.

**Done when:** users chat in real time and receive live notifications.

---

## Phase 9 — Operational hardening
**Depends on:** all above

- [ ] Scheduled PostgreSQL backups with a **tested restore**; measure and document
      RPO/RTO in the DR runbook (realistic single-server numbers).
- [ ] Health probes + Prometheus metrics wired; basic dashboards/alerts.
- [ ] Production Docker Compose + Caddy TLS validated.
- [ ] Localization (ru/tg) pass; strings externalized.

**Done when:** the platform deploys to the КЧС server, survives a restore drill,
and is observable.

---

## Later (post-v2.0 — only when triggered, see `ToR.md` §12)

- [ ] Integrate self-hosted **Jitsi (+ Jibri)** for audio/video + recording.
- [ ] **FastAPI** ML service for emergency forecasting (once real data flows).
- [ ] **ClickHouse** read-only analytics/log sink (if Postgres aggregation is a
      measured bottleneck).
- [ ] OpenSearch / mobile / others per their triggers.
