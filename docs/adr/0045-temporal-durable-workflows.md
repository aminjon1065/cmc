# ADR-0045: Temporal durable workflows + first workflow (case SLA escalation)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.1 (P3.1a + P3.1b)
**Depends on:** cases module (P2.10), event outbox (P2.1), Postgres (P0.x)

## Context

The platform needs durable, code-defined workflows for long-running, reliable
processes (SLA timers, incident response, approvals). P3.1 stands up
self-hosted **Temporal** and ships the **first workflow**: a per-case
SLA-escalation timer — replacing the cron sweep envisioned for cases (P2.10),
whose `cases.due_at` column was added for exactly this.

Delivered in two cycles:
- **P3.1a** — the Temporal substrate (server, gated client/worker seam, the
  `caseSlaWorkflow` + activities, a scheduler surface) proven end-to-end.
- **P3.1b** — wiring the scheduler into the CasesService lifecycle.

## Decision

### Self-hosted Temporal in dev compose, reusing Postgres

`temporalio/auto-setup` creates its schema in the existing Postgres (DBs
`temporal` + `temporal_visibility`) — no new datastore — plus `temporalio/ui`
on :8233. (Gotcha: auto-setup binds the frontend to the container IP, not
loopback, so the healthcheck addresses the service name.)

### Gated in-process worker (not a separate process) — confirmed with the user

A gated module in `apps/api` hosts the Temporal **worker**; activities reuse the
app's DI (TenantDatabaseService, OutboxService). One deploy unit, fully testable.
A separate `apps/worker` process is the eventual scale story, deferred.

Both the worker and the **client** are gated on `TEMPORAL_ENABLED` and
dynamic-import `@temporalio/*`, so the SDK never enters jest (the gated-lazy-seam
pattern used for NATS/ClickHouse/BullMQ/Vault). Off by default → a Noop client +
no worker, so dev/test/CI need no Temporal.

### Determinism-safe split

Workflow code (`workflows/`) imports only `@temporalio/workflow` + a **type-only**
activity contract; the worker bundles it (~1.4 MB) with no DB/Node leakage.
Activity implementations (`activities/`) are built from injected services and run
in the API process. `caseSlaWorkflow`: sleep until `due_at` → if the case is
still open, escalate; cancellable. The escalate activity is **idempotent**
(re-checks open + not-already-escalated) and writes an `sla_breached`
`case_activity` row + emits a `case.sla_breached` outbox event (→ the existing
P2.4 notifications consumer).

### Scheduler seam + lifecycle wiring

`CaseSlaScheduler` (`schedule`/`cancel`, deterministic `case-sla:<id>` workflow
id) hides Temporal from CasesService and is **best-effort** (a Temporal failure
is logged, never breaks case CRUD). CasesService drives it:
- **create** with `due_at` → schedule;
- **update** when `due_at` changes → schedule (open case) or cancel (cleared / not open);
- **transition** → cancel on leaving the open set (resolved/closed/cancelled),
  reschedule on reopen.

Rescheduling uses `workflowIdConflictPolicy: TERMINATE_EXISTING` — a new schedule
for a case atomically replaces any running timer, so a changed `due_at` moves the
timer with no client-side race.

## Consequences

**Positive**
- Durable SLA timers survive restarts; no polling cron. The substrate now exists
  for the incident-response workflow (P3.2) and the visual builder (P3.8).
- Zero impact when off (default): noop client, no worker, SDK never loaded.
- Verified live end-to-end through the real API: create-with-SLA auto-escalates;
  resolve-before-deadline cancels; reopen reschedules.

**Negative / deferred**
- **In-process worker** — workflow/activity code shares the API process; isolating
  it (`apps/worker`) + horizontal worker scaling is deferred.
- **One workflow** — only `caseSlaWorkflow`; incident response, approvals,
  automations, and the visual builder are later items.
- **Dev Temporal only** — a production Temporal (HA, its own datastore, mTLS,
  namespaces, archival) is a deployment concern, not wired here.
- **Single SLA per case** — one timer keyed by case id; multi-stage SLAs (warn →
  breach → escalate-tiers) are a follow-on (likely P3.2).
- No web surface for workflow state yet (the Temporal UI covers ops).

## Validation

- **Suite**: 288/288, 38 suites (+9 over P2.13 baseline). `temporal` (9, faked
  client): gating/noop; scheduler→client (workflowType/id/args + cancel); and the
  **lifecycle** — create-with-`due_at` schedules, create-without doesn't,
  terminal transition cancels, update sets/clears.
- **Live smoke** (real Temporal): worker bundles the workflow + polls `cmc-main`.
  P3.1a — start via client: 4 s SLA → `escalated` + `sla_breached` activity +
  `case.sla_breached` outbox; cancel → `cancelled`, no escalation. P3.1b —
  **through the API**: a case created with a 4 s `due_at` auto-escalates; a case
  resolved before its 5 s `due_at` is not escalated (timer cancelled).
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration
  (`sla_breached` rides the unconstrained `case_activity.kind`).
