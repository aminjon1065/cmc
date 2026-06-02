# ADR-0046: Incident-response workflow (page → ack-SLA → remind → escalate)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.2 (P3.2a + P3.2b)
**Depends on:** Temporal substrate (P3.1 / ADR-0045), incidents (P1.5), notifications (P1.6), RBAC (P1.1), event outbox (P2.1)

## Context

P3.2 is the second durable workflow on the Temporal substrate: an
incident-response choreography. The plan's full vision — assemble responders by
region+role, page on-call, open a war-room thread, generate a post-mortem — spans
modules that don't exist yet (no region/role responder model, no chat/thread
module, no external paging provider). So this delivers the **realistic core** on
the primitives we have, and documents the rest as follow-ons.

Scope + shape were confirmed with the user.

## Decision

### Scope: page → ack-SLA → remind → escalate

When a **high-severity** incident is created, a Temporal workflow pages the
responders, reminds them while the incident stays unacknowledged, and escalates
if the acknowledgement SLA elapses. "Acknowledged" = the incident has left the
`reported` state (someone triaged / picked it up). War-room, external paging, and
post-mortem generation are **deferred**.

### Trigger: auto-start for severity ≤ threshold

`IncidentsService.create` calls `IncidentResponseScheduler.onCreated`; the
scheduler starts the workflow only when `severity ≤ INCIDENT_RESPONSE_SEVERITY_THRESHOLD`
(default 2 → SEV-1/SEV-2; 1 = most severe). `update` re-evaluates on a severity
change (now-severe + open → start; else cancel); `transition` cancels when the
incident leaves the open set (resolved/closed/cancelled). All best-effort and
gated by `TEMPORAL_ENABLED` (off → the scheduler is a noop).

### Responders: assignee + reporter; escalate to `incident:resolve` holders

No region/role responder or on-call model exists, so "page on-call" = notify via
the P1.6 channels (in-app + email). Initial page + reminders go to the incident's
**assignee + reporter**. Escalation fans out to holders of **`incident:resolve`**
(the senior responders — `incident:manage` isn't in the catalog) via a new RBAC
**reverse lookup** (`RbacService.usersWithPermission(domain, action)`), and emits
an `incident.escalated` outbox event.

### Workflow shape

`incidentResponseWorkflow({tenantId, incidentId, ackSlaSec, reminderIntervalSec})`
is determinism-safe (only `@temporalio/workflow` + a type-only activity contract):
page → loop sleeping `reminderInterval` at a time up to `ackSla`, re-checking
status each tick and reminding while still `reported` → escalate in a
non-cancellable scope if unacknowledged at the deadline. Cancellable (the
scheduler cancels on resolve); the per-step status re-check is the belt-and-braces
against a cancel/timer race. Activities (`loadIncidentStatus`, `notifyResponders`,
idempotent `escalateIncident`) run in the API process via injected services; the
worker now hosts both the case-SLA and incident-response activity sets.

Supporting additions: notification kinds `incident.response` / `incident.escalated`;
`NotificationsService.notifyUsers` (public fan-out seam); `INCIDENT_OPEN_STATUSES`;
`NotificationsModule` made `@Global` so the worker can inject it.

## Consequences

**Positive**
- Severe incidents now get durable, restart-proof response choreography with
  reminders + escalation — no cron, no lost timers.
- Reuses the entire P3.1 substrate; the marginal cost was one workflow + three
  activities + a scheduler + small helpers.
- Verified live end-to-end through the API: a SEV-1 left unacknowledged pages,
  reminds, and escalates; one acknowledged (triaged) self-stops with no escalation.

**Negative / deferred (the plan's fuller vision)**
- **No responder model** — assignee+reporter only; "by region + role" assembly and
  on-call rotations need a responder/on-call module.
- **No external paging** (PagerDuty/Opsgenie) and **no war-room thread** (no chat
  module) — escalation is in-app + email.
- **No post-mortem generation** on resolve (would create a linked case/document
  from a template) — a clean follow-on.
- **Single-stage ack SLA** — one reminder cadence + one escalation tier; multi-tier
  escalation policies are future work.
- Acknowledgement is inferred from status (`reported` → anything), not an explicit
  "ack" action.

## Validation

- **Suite**: 295/295, 38 suites (+7 over the P3.1 baseline). `temporal` (16,
  faked client): incident scheduler (severe→start / low-sev→noop / cancel),
  `usersWithPermission` finds `incident:resolve` holders, and the **IncidentsService
  lifecycle** (severe create starts, low-sev doesn't, terminal transition cancels).
- **Live smoke** (real Temporal, 6 s ack-SLA / 3 s reminder, through the API):
  a SEV-1 incident left unacknowledged → 2× `incident.response` (page + reminder)
  + 1× `incident.escalated`; a SEV-1 acknowledged (triaged) before the deadline →
  0 escalations (workflow self-stops).
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration
  (`incident.escalated` is a new outbox verb; notification kinds are additive).
