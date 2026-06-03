# ADR-0059: Daily Merkle-anchor hardening — HA-safe anchoring, COMPLIANCE-mode guard, anchor-gap visibility

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P3.15 (extends P1.11 / ADR-0029)
**Depends on:** audit hash-chain + Merkle anchor (P1.11 / ADR-0029), Object-Lock storage (P1.11b), HA advisory-lock pattern (P3.13 / ADR-0058)

## Context

P1.11b already delivered the substance of "daily Merkle root anchoring": a
`@Cron(EVERY_DAY_AT_1AM)` seals each closed `(tenant, UTC-day)` chain, Merkle-roots
it, and writes the root to a MinIO **Object-Lock (WORM)** bucket with a
configurable lock mode + retention, recorded in `audit_chain_anchor` (unique on
`(scope, date)`), with verify-against-anchor. P3.15 hardens that for production
along three axes surfaced while reviewing it under the HA work (P3.13):

1. The daily cron fires on **every** API instance — anchoring wasn't serialized.
2. The lock mode defaults to **GOVERNANCE** (deletable by a privileged user) —
   prod needs **COMPLIANCE** (true WORM) per the project's security posture.
3. There was no way to *see* whether every past day is actually anchored — the
   anchor's whole point ("a dropped day is evident") had no operator surface.

## Decision

### 1. HA-safe anchoring (advisory lock)

`anchorChain` now takes `pg_advisory_xact_lock(ANCHOR_LOCK_KEY = 40_211_600)` as
the first statement of its privileged tx, held across the existing-check → WORM
write → insert. Concurrent daily crons on N instances serialize: the first
anchors; a loser blocks, then sees the existing row and returns idempotently — so
**no duplicate WORM object is written** and the unique-`(scope,date)` insert never
races. (Same advisory-lock family as the relay/sealer/export/projection/retention
singletons, P3.13.)

### 2. COMPLIANCE-mode posture guard

At boot (`onModuleInit`), if `NODE_ENV=production` **and** anchoring is enabled
**and** `AUDIT_ANCHOR_LOCK_MODE !== COMPLIANCE`, the service logs a loud error
explaining that GOVERNANCE anchors are deletable (BypassGovernanceRetention) and
therefore **not tamper-proof**, with the remediation. It warns rather than crashes
(anchoring is a feature, not a boot-critical dependency); the requirement is
documented as a mandatory prod setting.

### 3. Anchor-gap visibility

New `anchorStatus(tenantId, days)` + `GET /v1/audit/anchor/status?days=N`
(`tenant:manage`): per UTC day in the window, the sealed-row count and whether a
Merkle anchor exists, plus a **`gaps`** array — *past* days with sealed rows but
no anchor. That is the direct compliance signal an operator/auditor monitors: an
empty `gaps` proves continuous daily anchoring; a non-empty one flags a dropped
day to investigate.

## Consequences

- **Good**: anchoring is now correct under the 2×-API deploy (no double-WORM /
  insert race); production is steered to true-WORM COMPLIANCE mode; and the
  "dropped day is evident" guarantee is now *observable* (and alertable) rather
  than implicit. Small, surgical changes on top of the proven P1.11b core.
- **Trade-offs**: the prod guard warns (doesn't enforce) — a misconfigured deploy
  still runs, just loudly flagged; turning the warning into a hard refusal (or a
  startup health-check failure) is a future option. The gap endpoint is tenant-
  scoped (the `system` chain has no tenant surface yet). No automated alert wired
  on `gaps` yet (operator/SIEM consumes it) — a Prometheus/Alertmanager rule is a
  natural follow-on.

## Validation

- **e2e** (`audit-anchor.e2e-spec` 9/9, +3): a past sealed-but-unanchored day
  appears in `gaps` and clears once anchored; **concurrent `anchorChain`** writes
  the WORM object exactly once and records a single anchor (advisory lock);
  `anchor/status` endpoint 403 non-admin / 200 admin. Full suite **53 suites /
  389 tests**, zero regressions. `tsc` / `eslint` / `nest build` clean.
- The real WORM write + COMPLIANCE retention continue to be covered by the
  P1.11b live smoke (tests fake StorageService to stay off MinIO under jest).
