# CMC — Implementation Plan

Single source of truth for **build order**. Scope is defined by [`ToR.md`](./ToR.md). This plan sequences the in-scope work and tracks progress to bring the CMC platform to a consistent and verified state for a single-organization on-premise deployment.

## How to use this file

- Work **one phase at a time, top to bottom**.
- Tick a box only when its **done-criteria** are met and the build + tests are green.
- Every architectural decision → an ADR. Every removed capability → its ADR marked `Superseded`.
- **No scope creep.** If a task is not in `ToR.md` §5 (in-scope), it does not get built.

**Status:** `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Facts, baseline, and specification
**Goal:** Establish the baseline, update documents according to the current target product (including AV/Recording via LiveKit), and define the initial spec.

- [x] Read project docs, check git status, and test scripts to form the baseline.
- [x] Update `docs/ToR.md`, `docs/plan.md`, and `ADR-0080` to reflect that AV/recording (via LiveKit) is IN SCOPE.
- [x] Create detailed specifications:
  - `docs/specs/analytics-data-gis.md`
  - `docs/specs/documents-tasks-communication.md`
  - `docs/specs/organization-access.md`
  - `docs/specs/operations-acceptance.md`
- [x] Set up `docs/audit/EXECUTION_CHECKPOINT.md` to track current work state.

**Done when:** All specifications are aligned with the new product goals, baseline issues are recorded, and the plan is fully updated.

---

## Phase 1 — Access, domain entry, and minimal reliability
**Goal:** Close critical gaps in auth/MFA, region/object scope, ingestion, and background reactions. Prepare a secure test environment.

- [ ] Complete web scenario for MFA (TOTP, backup codes, session revocation).
- [ ] Enforce unified matrix of access (region/object scope) in API, FTS, websocket, and reports.
- [ ] Fix ingestion inconsistencies (e.g. `regionId` on incidents, audit events on import).
- [ ] Make background reactions reliable (event emitter idempotency, recovery).
- [ ] Set up a restorable test database environment.

**Done when:** Access is fully secure, imports write correct data with audit trails, and baseline tests (AC-04, AC-05, AC-01 partial) pass.

---

## Phase 2 — First end-to-end analytical scenario with GIS
**Goal:** Implement the primary data lifecycle: Catalog/Registry → Import → Table → Metrics → Map → PDF/XLSX Report.

- [ ] Define and implement the required dataset registry (e.g., incidents).
- [ ] Implement solid CSV/XLSX data ingestion (preview, column mapping, validation, error reporting).
- [ ] Implement analyst workspace UI: filtering, sorting, column selection.
- [ ] Compute baseline indicators (count, distributions) safely on PostgreSQL.
- [ ] Implement geospatial operations (filtering by region, intersections) against PostGIS layers via Web and external GIS (WMS/WFS).
- [ ] Implement report builder and exporter (PDF/XLSX) reflecting live or frozen data.

**Done when:** AC-01, AC-02, AC-03 pass. Analysts can complete an end-to-end data task without raw SQL.

---

## Phase 3 — EDMS, files, and tasks
**Goal:** Safe document versioning, hierarchical file manager, and task manager with delegations.

- [ ] Implement document lifecycle (registration, approval paths, substitution).
- [ ] Complete hierarchical file manager UI and backend (upload, move, rename, versions, trash/restore).
- [ ] Prevent concurrent edit conflicts and implement retention policies.
- [ ] Implement task manager: Kanban boards, task assignment, delegations (chief → subordinate), acceptance of results.
- [ ] Integrate EDMS and Tasks with Incidents and Cases.

**Done when:** AC-06, AC-07, AC-08 pass. Users can route documents, manage files securely, and assign/accept tasks.

---

## Phase 4 — Private communication, AV, and recording
**Goal:** Secure chat, realtime connections, and robust LiveKit-based media pipelines.

- [ ] Solidify Chat (DM, closed/open channels, unread state, history, connections).
- [ ] Authorize WebSocket subscriptions properly.
- [ ] Connect and harden LiveKit AV for 1:1 and group conferences.
- [ ] Implement recording lifecycle (start/stop, robust readiness checks, secure download).

**Done when:** AC-09, AC-10 pass. Real-time media, chat, and recordings work on a real self-hosted service and are fully scoped.

---

## Phase 5 — Overall acceptance and operational readiness
**Goal:** Polish global search, backups, load handling, and offline capabilities.

- [ ] Complete cross-platform full-text search (with proper object/region scope).
- [ ] Prove full disaster recovery (RPO/RTO) on an isolated environment with files, db, and recordings.
- [ ] Perform capacity and load checks against analytical and GIS operations.
- [ ] Ensure the system can run offline (local basemaps, fonts, styles).
- [ ] Clean up unresolved ADRs and finalize documentation.

**Done when:** AC-11, AC-12 pass, runbooks are updated, and the application is production-ready for deployment.
