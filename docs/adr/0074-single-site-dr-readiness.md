# ADR-0074: Single-site DR readiness — backup-freshness check + RPO/RTO + restore drill

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.DR (single-site disaster-recovery readiness — reframed from the N/A P5.7 multi-region active-active)
**Builds on:** nightly Postgres backups (P0.5 / ADR-0012), StorageService (S3), monitoring perm (P4.3)

## Context

P5.7 (multi-region active-active) is **N/A** for this deployment — it needs ≥2
datacentres, but the КЧС reality is **single-site** (server + backups at the head
office). The meaningful resilience guarantee single-site is **"a fresh,
restorable backup always exists"**: you can't fail over to a second site, so a
verified recovery point + a rehearsed restore is the DR posture.

P0.5 already writes nightly `pg_dump`s to the backups bucket
(`postgres/YYYY/MM/cmc-<ISO-Z>.dump`), and the original P0.5 deferred an
"Alertmanager: no fresh backup in 36 h" alert. P5.DR makes backup freshness
**observable via the API** (the alert hook) and documents RPO/RTO + the drill.

## Decision

### Backup-freshness check

`StorageService.listObjects(bucket, prefix)` (new — `ListObjectsV2`).
`BackupStatusService.status()` lists `postgres/` `*.dump` objects in the backups
bucket, picks the newest by `lastModified`, computes its age, and flags `fresh`
when age ≤ the RPO window. `GET /v1/ops/backups/status` (`@Authorize
monitoring:read`) → `{bucket, count, latestKey, latestAt, ageHours, rpoHours,
fresh}`. Config `BACKUP_S3_BUCKET` (`cmc-backups`) + `BACKUP_RPO_HOURS` (36,
matching the P0.5 alert threshold). Platform-level (not tenant-scoped) — the
backups bucket holds whole-DB dumps; the freshness signal is ops visibility, not
tenant data.

### RPO/RTO + restore drill

`docs/runbooks/disaster-recovery.md`: the single-site RPO (≤ `BACKUP_RPO_HOURS`)
and RTO targets, the `pnpm db:restore` drill (already rehearsed in P0.5), the
replica/Sentinel profiles (P3.13) for warm standby, and the air-gap rebuild path
(P5.8). Explicitly states what single-site DR is **not** (no active-active — P5.7).

## Consequences

- **Positive:** turns "are backups actually fresh?" into a checkable signal (+ the
  hook for an Alertmanager rule); reuses P0.5 + StorageService; honest single-site
  resilience without pretending to multi-region; no DB, no migration, gated by an
  existing perm.
- **Negative / trade-offs:** lists one page (`MaxKeys`, newest-by-`lastModified` —
  fine for daily dumps with retention); **does not verify the dump is restorable**
  (only that it exists + is fresh — a periodic test-restore is the stronger,
  follow-on guarantee); the Prometheus gauge + Alertmanager rule + a scheduled
  freshness notification are follow-ons; RTO is documented, not automated.

## Validation

- e2e `backup-status` **4/4**: fresh (within RPO, ignores non-`.dump`), stale
  (older than RPO → `fresh:false`), empty (`count:0`, nulls, not fresh), RBAC 403
  for a role-less viewer. Faked StorageService listing. `tsc`/eslint clean.
- **Boundary:** real MinIO listing of the P0.5 dumps = live boundary; the
  restore drill is a manual rehearsal (documented).

## Files

- `apps/api/src/modules/backups/` (`backup-status.service.ts`,
  `backup-status.controller.ts`, `backups.module.ts`);
  `StorageService.listObjects`; `packages/contracts/src/backup.ts`;
  `BACKUP_S3_BUCKET` + `BACKUP_RPO_HOURS` config; `app.module.ts`;
  `docs/runbooks/disaster-recovery.md`.

## Follow-ons

- Prometheus `cmc_backup_age_hours` gauge + Alertmanager "no fresh backup in N h".
- Scheduled freshness notification (reuse the notifications plane).
- Periodic **test-restore** job (verifies restorability, not just freshness).
- WAL streaming / PITR (tighter RPO) if the single-site posture is upgraded.
