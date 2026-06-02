# ADR-0040: Cases module

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.10
**Depends on:** ADR-0023 (incidents pattern), ADR-0019 (RBAC), ADR-0031 (event plane)

## Context

Cases are the second operational domain module (after incidents): a tracked unit
of work (investigation, request, task) with a lifecycle, an assignee, an SLA
target, and a history. The dashboard already references "Cases Open" (hardcoded).

## Decision

Build the **backend** of cases modelled directly on incidents (P1.5), plus an
**activity timeline** — and defer the heavier sub-features with explicit notes.

### Modelled on incidents

`cases` (title, type, priority 1..5, status, assigned_to, opened_by, due_at,
resolved_at, closed_at, soft-delete) with a status state machine
(`CASE_TRANSITIONS`: open → triage → in_progress → resolved → closed, +
cancelled) shared by API + web. RLS (two-GUC) for tenant isolation; every
read/write in the request tenant tx; audited; domain events
(`case.created/transitioned/assigned`) to the outbox (P2.1). Resolving/closing
needs `case:resolve` on top of `case:write`. Priority is bounded by a DB CHECK
(1..5) on top of the Zod contract. Permissions `case:read/create/write/assign/
resolve/delete` (single-token actions — keys split on one colon, the lesson from
ADR-0037).

### Activity timeline

`case_activity` (append-only) records system entries (`created`,
`status_changed`, `assigned`) the service writes inside the same tx as the state
change, plus user `comment`/`note` entries. `GET /v1/cases/:id/activity` returns
the timeline newest-first; `POST /v1/cases/:id/comment` adds a comment.

### Scope: backend MVP

Delivered: CRUD, lifecycle, assignment, activity timeline, stats, events. The
plan's heavier items are **deferred** (noted below): config-driven case types
(type is free text for now), assignment policies, SLA escalation cron
(`due_at` is stored; auto-escalation lands with Temporal, P3.1), linked artifacts
(incident/document/gis_feature), a per-tenant human `case_number`, and the web
UI (the dashboard's "Cases Open 142" stays hardcoded until a cases UI/stats wire-
up).

## Consequences

**Positive**
- A second domain module reusing the proven incidents conventions (state
  machine, RLS, audit, outbox) — small net-new surface, consistent API shape.
- Activity timeline gives cases an auditable, user-visible history out of the box.
- Verified live: create → in_progress → comment → timeline
  (`created/status_changed/comment`) → stats (`openTotal:1`).

**Negative / deferred**
- **No web UI yet** — backend only (dashboard "Cases Open" still hardcoded).
- **No SLA escalation** (cron/Temporal — P3.1); `due_at` is informational.
- **No config-driven case types / assignment policies / linked artifacts /
  case_number** — all follow-ons.
- No case events consumer yet (events hit the outbox/NATS; no projection or
  notification wired — a later hook, like P2.4/P2.5 for incidents).

## Validation

- **Suite**: 261/261, 33 suites. `cases` (7): CRUD + soft-delete; state machine
  (invalid → 400, resolved sets `resolvedAt`, reopen clears it); assign (tenant
  user, cross-tenant → 400, unassign); activity timeline
  (created/status_changed/assigned/comment, newest-first); stats; RBAC (role-less
  → 403); tenant isolation (RLS).
- **Live smoke** (booted API, seed): create → transition → comment → activity
  `comment,status_changed,created` → stats `openTotal:1, byStatus:{in_progress:1}`.
- **Migration**: 0019 (cases + case_activity + indexes + priority CHECK + RLS)
  applied to dev + `cmc_test`. **Build/lint**: API `tsc`/`nest build`/`eslint` +
  db + contracts clean.
