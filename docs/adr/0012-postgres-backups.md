# ADR-0012: Postgres backups via compose sidecar

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.5
**Closes tech-debt:** TD-004
**Depends on:** ADR-0001 (Postgres + MinIO as Day-1 services)

## Context

The platform has zero disaster recovery posture today. Any loss of the
`cmc-postgres-data` volume (corrupted FS, accidental `infra:reset`, stolen
host) is total loss of the state of record — users, sessions, audit log,
documents metadata.

ToR §13.6 lists backups as a baseline operations capability. TD-004
captured the gap as **S0 — blocking** for any non-dev deployment, and
PRIORITY_EXECUTION_PLAN sequenced it as P0.5 with sizing **S (1 d)**.

This ADR captures the minimum sufficient design: nightly `pg_dump` into
the existing MinIO bucket, with a documented restore path that the team
can rehearse before the first deploy.

## Decision

### 1. Scope: Postgres only

The only authoritative state today lives in Postgres. Redis is a cache
(losing it returns to baseline DB load — see ADR-0011); MinIO holds
document bytes that have their own DR story (object storage replication,
versioning, or a parallel `mc mirror` job — not in this ADR's scope).

So this ADR covers `cmc` DB only. MinIO content backup and WAL-based PITR
are explicit follow-ons (see §"Triggers for re-evaluation").

### 2. Mechanism: nightly `pg_dump` from a sidecar container

A new compose service `postgres-backup` runs busybox `crond` in the
foreground and executes `/usr/local/bin/backup.sh` on the configured
schedule (default `0 3 * * *` UTC).

**Why a sidecar rather than a host cron or external scheduler:**

- The compose project is the unit of deployment. Adding a host-level cron
  splits "what the platform needs to run" across two places — the
  operator has to remember it on every fresh deploy.
- A sidecar reuses the existing compose networking — `postgres` and
  `minio` are reachable by hostname without extra config.
- The same image is used for both scheduled runs (cron) and manual runs
  (`docker compose exec`), so the operational and automated paths exercise
  the same script.

**Why `pg_dump` and not WAL streaming / pgBackRest / Barman:**

- `pg_dump` is in the stdlib of the Postgres client package; zero
  additional moving parts.
- For ~50 MB to a few GB of data (the realistic Horizon-1 envelope), a
  nightly logical dump is well under the budget — sub-second to seconds.
- WAL streaming buys PITR and lower RPO, but introduces a separate
  archive coordination problem, a primary-side `archive_command`, and a
  restore tool. None of that is justified before there is a real RPO
  contract to honour. Sequencing item — see §"Triggers for re-evaluation".

### 3. Image: `cmc/postgres-backup:16` (built from `infra/backup/`)

Single alpine image bundling `postgresql16-client` (matched to the major
version of `postgis/postgis:16-3.4`), `mc` (pinned to the same release
`minio-init` already uses), busybox `crond`, and bash. The image is built
locally by compose so no registry credentials are needed and the version
moves with the repo.

### 4. Format and location

| Aspect | Value |
|---|---|
| Format | `pg_dump --format=custom --compress=9` (`.dump`) |
| Bucket | `${BACKUP_BUCKET}` (default `cmc-backups`, pre-created by `minio-init`) |
| Key | `postgres/<YYYY>/<MM>/cmc-<ISO-8601-Z>.dump` |
| Schedule | `${BACKUP_SCHEDULE_CRON}` (default `0 3 * * *` interpreted in `${BACKUP_TZ}`, default `UTC`) |
| Retention | `${BACKUP_RETENTION_DAYS}` days (default `7`) |
| Pruning | `mc rm --recursive --force --older-than ${RETENTION_DAYS}d` after each upload |

Custom format chosen over plain SQL because `pg_restore` can stream,
fail-fast on errors, and (in future) parallelize across jobs without
re-dumping.

ISO-8601 timestamps (`YYYY-MM-DDTHH-MM-SSZ` — colons swapped for hyphens
so the key is filesystem-friendly) sort lexicographically, which is what
the `restore.sh latest` resolver relies on.

### 5. Roles are intentionally not backed up

`pg_dump` does not capture `CREATE ROLE` even at the database level, and
`pg_dumpall --globals-only` was deliberately rejected:

- Within the same compose project, the `cmc` and `cmc_app` roles are
  created once by `infra/postgres/init/02-roles.sql` on the initial
  container start. Restoring into the same cluster never needs them
  re-created.
- For cross-cluster DR, the runbook will instruct the operator to run the
  same init scripts (`01-extensions.sql`, `02-roles.sql`) before restore.
  This keeps the dump self-consistent and the runbook explicit, instead
  of mixing role bytes into a per-database dump that may or may not be
  the right ones for the target cluster.

### 6. Restore is a separate, destructive, confirmed operation

`/usr/local/bin/restore.sh <key|latest>` in the same container:

1. Resolves `latest` via `mc find ... | sort | tail -n 1` (works because
   keys are timestamp-sorted).
2. Downloads the object to `/tmp`.
3. Requires confirmation: prompts the operator to retype the target
   database name when stdin is a TTY; requires `CONFIRM_RESTORE=yes` in
   the environment otherwise.
4. Terminates active connections, drops the target DB, recreates it.
5. `pg_restore --exit-on-error` into the fresh DB.

The "fresh container" promise from P0.5 is satisfied by the
DROP+CREATE+restore sequence — even if the previous restore failed
mid-way, the next attempt starts from a guaranteed-empty target.

### 7. UX: `pnpm db:backup` / `pnpm db:restore`

Two top-level scripts in the root `package.json`:

```
pnpm db:backup                       # one-shot manual backup
pnpm db:restore postgres/2026/...    # restore explicit key
pnpm db:restore latest               # restore newest dump
```

Both dispatch to `docker compose exec`. `db:backup` passes `-T` (no TTY;
script is fully scripted). `db:restore` does **not** pass `-T` so the
confirmation prompt works in a typical operator session; it does pass
`-e CONFIRM_RESTORE` (var-name only, no `=value`), which is `docker
compose`'s passthrough form — the value is forwarded from the host shell
only when the operator actually sets it.

The pnpm wrapper deliberately does not hardcode `CONFIRM_RESTORE=yes` —
the prompt is the safety net, and skipping it requires an explicit
`CONFIRM_RESTORE=yes pnpm db:restore ...` invocation that signals "I
mean it" loud and clear. This pattern was caught during the P0.5 restore
drill: without the `-e` passthrough, scripted callers received the
"CONFIRM_RESTORE=yes required" error even after setting the variable
locally, because compose-exec doesn't inherit the host environment by
default.

### 8. Failure-mode handling

- `backup.sh` `set -euo pipefail` — pg_dump failure or upload failure
  exits non-zero, cron logs the run, the next run tries again.
- Retention pruning failure is `|| true` — a transient `mc` glitch must
  not poison the run that successfully produced and uploaded a dump. The
  next run will re-attempt the prune.
- The mc bucket-ready check at `entrypoint.sh` makes a missing bucket
  loud at container start rather than at first cron fire.

### 9. Observability today is `docker logs cmc-postgres-backup`

The cron command redirects stdout/stderr to `/proc/1/fd/{1,2}` so the
crond process forwards script output to the container's stdio. `docker
compose logs postgres-backup` shows every run's lifecycle (`pg_dump
complete`, `uploading`, `rotation`, `done`).

No Prometheus metric / alert on backup-failure today — that lands with
the observability stack (P0.7 / P1.8). The interim signal is "absence of
a fresh object in the bucket" which the operator can verify with
`mc ls minio/cmc-backups/postgres/ --recursive`.

## Consequences

**Positive:**

- TD-004 retired. The S0 backup gap is closed.
- P1 (first deploy) is unblocked — backups exist before any byte of
  production data does.
- The restore drill is rehearsable on a developer laptop end-to-end with
  the same scripts that run in compose. No "restore tool we've never
  tried in anger" surprise.
- The `pnpm db:restore` workflow doubles as the "wipe and reload from a
  known-good snapshot" affordance for local dev / CI.

**Negative / known gaps:**

- **RPO = 24 hours.** Nightly dump means up to a day of data loss in the
  worst case. Acceptable for a pre-launch foundation; the moment real
  user data flows, this contracts to ≤ 5 min per ToR §1.5 — addressed via
  WAL streaming at P3 (see triggers).
- **Backups are not encrypted at the application layer.** They live in
  MinIO under the bucket's SSE-S3 / SSE-KMS config (depending on
  deployment) but the dump bytes are not Vault-wrapped. Acceptable today
  because dev MinIO has no SSE configured anyway; the right place to fix
  this is when Vault arrives (P2.14).
- **Backups are not signed.** No tamper-evidence on the dump itself
  (separate from the audit-log Merkle root, P1.11). The next operator
  cannot prove a downloaded dump matches what was uploaded. Acceptable
  for the dev/MVP window.
- **No cross-region replication of backups.** Same blast radius as the
  primary host in single-host compose. Mitigated when deploy moves to
  multi-host / cloud object storage with cross-region replication.
- **No restore verification in CI.** The drill is documented and
  runnable, but the GHA pipeline does not yet exercise it on every PR.
  Cheap follow-on once the test infra docker layout stabilises.
- **MinIO content (uploaded documents) is not in scope.** Object
  durability today is whatever the MinIO single-node FS gives; a
  parallel `mc mirror` job to a secondary bucket is the obvious next
  step but lives in a separate item.

## Triggers for re-evaluation

- First production tenant onboards → write the runbook for cross-cluster
  restore (init scripts → restore.sh) and rehearse it on a clean host.
- RPO requirement contracts below 24 h → introduce WAL archiving
  (`archive_command` to MinIO, pgBackRest as the orchestrator). At that
  point this `pg_dump` cadence becomes a weekly full + WAL between.
- First compliance audit asks "show me the backup integrity check" →
  add `sha256sum` on the dump uploaded as an object metadata field +
  re-verify on restore.
- Backup size grows enough that 24 h dumps overlap or saturate the
  network → switch to parallel `pg_dump --jobs N` (custom format already
  supports this) or move to physical backups.
- `pnpm db:restore` becomes a frequent dev workflow → add a `--target` flag
  to restore into a parallel DB (e.g., `cmc_snapshot_2026_05_25`)
  without dropping the live one.
- Backups need to leave the cluster (off-site DR) → add a `mc mirror`
  sidecar pushing `cmc-backups` to a remote S3-compatible endpoint.

## References

- [PRIORITY_EXECUTION_PLAN P0.5](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-004](../audit/TECH_DEBT_REGISTER.md)
- [ADR-0001](./0001-initial-architecture-and-stack.md) — Postgres + MinIO baseline
- [ADR-0004](./0004-documents-and-rls-role-split.md) — `cmc` vs `cmc_app` roles (explains why role bytes aren't dumped)
- ToR §1.5 (RPO/RTO targets), §13.6 (backups), §13.7 (DR)
