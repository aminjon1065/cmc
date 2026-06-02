# ADR-0053: Visual workflow builder (interpreter-on-Temporal + React Flow)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.8 (a: definition store; b: interpreter run engine; c: event triggers; d: web editor)
**Depends on:** Temporal substrate (P3.1 / ADR-0045), event bus + dedup (P2.1/P2.4 / ADR-0031,0032), RBAC (P1.1), notifications (P1.6), incidents (P1.5)

## Context

ToR §3.10 / §10 call for a visual, no-code workflow builder. The plan said
"compile-to-Temporal", but our Temporal worker bundles workflows at startup
(`workflowsPath`) — it cannot load new compiled workflow files at runtime. Three
points were confirmed with the user: a **generic interpreter** (graph-as-data,
not code-gen), a **focused MVP node set**, and **manual + event** triggers.

## Decision

### Definitions as data (P3.8a)

`workflows` (`definition` JSONB `{nodes, edges}`, `version`, `enabled`,
`trigger_type`/`trigger_event`, RLS, soft-delete). Node types are a Zod
discriminated union (`start`, `end`, `notify`, `delay`, `condition`,
`create_incident`) with per-type config; `validateWorkflowDefinition` enforces a
runnable DAG (one start, ≥1 end, edges reference nodes, condition has true+false
branches, action nodes have one outgoing edge, all reachable, acyclic). CRUD +
`POST /workflows/validate` (`workflow:*`). Drafts may be saved incomplete;
**enabling or running requires a valid DAG**. Bodies are Zod-parsed in the
service (the definition is too deep for class-validator).

### One generic interpreter workflow (P3.8b)

A single Temporal workflow, `workflowInterpreter`, executes **any** authored
graph passed as its argument. Control nodes (start/end/delay via `sleep`/
condition via `context[path] === equals`) run in-workflow; side-effecting nodes
(notify, create_incident) call activities. So adding or editing a workflow never
needs a worker redeploy. The workflow is **determinism-safe**: it imports only
`@temporalio/workflow` + a type-only activity contract, and declares the graph
types locally (no `@cmc/contracts` runtime in the sandbox). A `workflow_runs`
row snapshots the graph at start (immutable; editing the workflow can't change a
past run) and is driven pending→running→completed/failed by `markRunStatus`.
`WorkflowsService.startRun` snapshots + starts the interpreter
(`wf-run:<id>`); `POST /workflows/:id/run` (`workflow:run`) + run-status reads.

### Event triggers (P3.8c)

A durable JetStream consumer (`workflow-trigger`, `filter_subjects:
["tenant.>"]`) matches each event's `${aggregateType}.${eventType}` against
enabled, event-bound workflows and starts a run of each (system actor, event
payload as input). `EventDedupService.claim` is taken only once a match exists,
so the common no-match event writes no ledger row; at-least-once + the claim
make redelivery idempotent. Reuses the P2.4b subscriber pattern.

### Web editor (P3.8d)

`/workflows` (list) + `/workflows/:id` — a React Flow (`@xyflow/react`) canvas:
a node palette, drag-to-connect edges (condition edges auto-labelled
true/false), a per-node config inspector, and Validate / Save / Run buttons with
a recent-runs panel. Server actions (`authedApiFetch`) back each mutation. The
sidebar "Workflows" entry is enabled; `/workflows` is auth-protected in
middleware.

## Consequences

**Positive**
- Author + run automations with no deploy — the graph is data, the interpreter
  is one stable, determinism-safe workflow.
- Runs are durable + observable (Temporal retries activities; `workflow_runs`
  records status/output/error). The snapshot makes runs reproducible.
- Both manual and event-driven starts share one run engine (`startRun` /
  `startTriggeredRun`); RLS + `workflow:*` confine everything per tenant.
- The node set maps to existing services (notifications, incidents), so the
  builder is immediately useful.

**Negative / deferred**
- **MVP node set** — no loops, parallel/fan-out, sub-workflows, human-approval
  (wait-for-signal), HTTP/webhook, or create-case nodes yet. The graph is a
  DAG (no cycles by design).
- **Best-effort `create_incident`** activity inserts the row directly (no audit/
  outbox event for the spawned incident yet).
- **Event trigger consumer filters `tenant.>`** (all events) and matches in the
  handler — simple, slightly chatty; a per-subject filter is a future tuning.
- A failed event-trigger start isn't retried past the dedup claim (matches the
  existing consumer tradeoff).
- The editor is functional, not polished (no undo, autosave, or run-step
  visualisation).

## Validation

- **API suite**: 351/351, 48 suites (+15 over P3.5). e2e: `workflows` (CRUD +
  DAG validation + enable-gating + RBAC + RLS), `workflow-runs` (snapshot +
  interpreter start + run-status, faked Temporal seam), `workflow-triggers`
  (event → auto-start, dedup, disabled/no-match skip, fan-out).
- **Live smokes** (real Temporal worker via `createApplicationContext`):
  - P3.8b: start→notify→create_incident→end runs to `completed`; real incident +
    `workflow.notify` notification; output + finishedAt set.
  - P3.8c: a synthetic `incident.created` auto-starts a bound workflow → interpreter
    completes (real side effects); redelivery deduped.
- **Web**: `next lint` + `next build` clean (`/workflows` + `/workflows/[id]`
  built, React Flow bundle). Runtime smoke: both routes 307→`/login`
  unauthenticated (middleware live).
- **Build/lint**: contracts + API `tsc`, `nest build`, `eslint` clean.
  Migrations `0025` (`workflows`) + `0026` (`workflow_runs`). New deps
  `@xyflow/react` (web); `workflow.notify` notification kind.
