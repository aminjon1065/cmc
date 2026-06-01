# ADR-0029: Tamper-evident audit log — hash chain + Merkle anchoring

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.11 (a + b)
**Depends on:** ADR-0010 (audit log), ADR-0011/0012 (RLS, backups), ADR-0019 (RBAC)
**ToR:** §3.15 (tamper-evident, WORM, SIEM-exportable audit)

## Context

The `audit_log` table is **append-only** — RLS policies (`audit_log_no_update`,
`audit_log_no_delete`, migration 0002) deny UPDATE/DELETE to every
non-privileged context. The `prev_event_hash` / `this_hash` columns existed
from day one but nothing populated them. Append-only stops the *application*
from rewriting history; it does **not** detect a privileged/DB-level actor (a
rogue superuser, a doctored backup, storage-layer tampering) editing rows in
place. ToR §3.15 wants **tamper-evidence**: cryptographic proof that the log
wasn't altered.

## Decision

Two complementary detection layers over the append-only base.

### Layer 1 — per-row hash chain (P1.11a)

Each row is bound to its predecessor:
`this_hash = SHA256(canonical(row) | prev_event_hash)`, within a chain
partitioned by **`(tenant_id, occurred_at::date UTC)`**. The first row of a
chain anchors to a deterministic genesis seed `SHA256("cmc-audit-genesis:" |
scope | day)`. A new `seq bigserial` gives a monotonic, consistent walk order.

**Async sealer, not synchronous-at-write.** Rows insert on the hot path exactly
as before — fast, atomic with the audited action, no locks. A sealer
(`AuditChainService.sealPendingChains`) fills the hashes shortly after, in `seq`
order, under a blocking advisory lock (one sealer cluster-wide). This was a
deliberate choice over the plan's implied synchronous chaining: synchronous
chaining must hold the chain lock until the request commits, which **serialises
a tenant's concurrent audit-writing requests** and risks cross-transaction
self-deadlock with the existing `durable` (separate-tx) audit path. Async
sealing keeps the hot path lock-free; the seal latency (a configurable interval,
default 60 s; also on-demand) is an acceptable window given append-only already
holds via RLS. Verification (`verifyChain`) recomputes the chain and pinpoints
the first tampered/missing row by `seq`.

### Layer 2 — daily Merkle anchor under Object Lock (P1.11b)

The chain detects in-place edits, but a sufficiently privileged attacker could
re-seal a whole day with self-consistent hashes. So a daily cron
(`@nestjs/schedule`, 01:00 UTC) Merkle-roots each **closed** sealed chain and
writes the root to object storage under **S3/MinIO Object Lock (WORM)** — an
immutable, retention-protected anchor. `verifyChain` recomputes the day's
current Merkle root and compares it to the anchored root (`rootMatches`): a
mismatch means the day's rows changed after anchoring. A *missing* anchor for a
past day is itself evidence (you can't silently drop a whole day).

- **Bucket**: `cmc-audit-anchors`, created **with object lock enabled** (can't
  be enabled retroactively) — provisioned by `minio-init` (`mc mb --with-lock`).
- **Retention**: `AUDIT_ANCHOR_RETENTION_DAYS` (default 3650 = 10 y).
  `AUDIT_ANCHOR_LOCK_MODE` — **GOVERNANCE** (dev/test default; a privileged user
  can override with BypassGovernanceRetention) or **COMPLIANCE** (immutable even
  to root until retention expires — recommended in prod).
- **Index**: `audit_chain_anchor` table records the root + `last_seq` (pins
  exactly which rows the root attests) + the object key/version/retain-until.
  Append-only itself (same RLS shape as `audit_log`).

### Privileged execution

Sealer, anchorer, and verifier run under `runPrivileged` (`app.bypass_rls=on`)
— the only context the `audit_log_no_update` policy permits to write the hashes,
and the only one that can read the tenant-less (`system`) chain. The
`(tenant, day)` partitioning bounds each chain so they seal/anchor/verify
independently (no global serialisation, the §14 concern).

### Why not write-time chaining / a head table

Both considered. A `SELECT … FOR UPDATE` head table or `pg_advisory_xact_lock`
in the request transaction serialises a tenant's audit-writing requests for
their whole tail (lock held to commit) and can self-deadlock the dual-write
paths. Async sealing avoids both while keeping the audit insert atomic with its
action. The chain's per-`(tenant, day)` independence + the daily Merkle anchors
give cross-day integrity without linking days into one serial chain.

## Consequences

**Positive**
- ToR §3.15 tamper-EVIDENCE satisfied: in-place edits caught by the chain,
  whole-day replacement / dropped days caught by the WORM Merkle anchor.
- Hot path unchanged — audit inserts stay fast, atomic, lock-free.
- Anchors are genuinely immutable (MinIO-enforced retention; verified live).
- Gated compliance endpoints: `GET /v1/audit/chain/verify`,
  `POST /v1/audit/chain/seal`, `POST /v1/audit/chain/anchor` (`tenant:manage`,
  own-tenant chain).

**Negative / deferred**
- **Seal latency window** — a row is briefly unsealed; tightened by the interval
  / on-demand seal, bounded by append-only RLS in the meantime.
- **Manual same-day anchor** captures a point-in-time (unique per `(scope,day)`)
  — the cron anchors closed days; same-day manual anchoring is for ops/tests.
- **`system` (tenant-less) chain verification** is privileged-only — no tenant
  endpoint (platform-superadmin surface → later).
- **A dedicated `audit:read` permission + auditor role** would be cleaner than
  reusing `tenant:manage`; deferred.
- **SIEM export** of the (now tamper-evident) log → P1.12.

## Validation

- **Suite**: 188/188, 22 suites. `audit-chain` (7): seal/verify, genesis +
  linkage, in-place tamper → `brokenAtSeq`, idempotent re-seal, per-tenant
  independence, gated endpoints. `audit-anchor` (6): Merkle + WORM write (faked
  storage), `anchored`/`rootMatches`, idempotency, post-anchor hash tamper →
  `rootMatches:false`, pending-chain skip, gated endpoint.
- **Live smoke** (dev DB + MinIO):
  - Chain: seal 145 rows / 5 chains → verify `valid`; tamper a sealed row as the
    Postgres superuser (past append-only RLS) → `valid:false, brokenAtSeq:53`;
    restore → `valid:true`.
  - Anchor: `POST /anchor` → Merkle root over 102 rows, `versionId`,
    `retainUntil` 2036; verify `anchored:true, rootMatches:true`; `mc retention
    info` → **`GOVERNANCE, expiring in 3649 days`**; `mc rm` only created a
    delete marker — the locked version stays protected.
- **Build/lint**: API `tsc` + `nest build` clean.
