# Runbook: Single-site disaster recovery (P5.DR / ADR-0074)

The CMC platform is **single-site** (server + backups at the КЧС head office, no
second datacentre — P4.6/P4.7). There is **no multi-region active-active**
failover (P5.7 N/A). The DR posture is therefore: **a fresh, restorable backup
always exists, and the restore + rebuild paths are rehearsed.**

## Targets

| Objective | Target | Backed by |
|---|---|---|
| **RPO** (max data loss) | ≤ `BACKUP_RPO_HOURS` (default **36 h**) | P0.5 nightly `pg_dump` (cron `BACKUP_SCHEDULE_CRON`) |
| **RTO** (time to restore) | hours (single host) | `pnpm db:restore` + `docker compose up` |
| **Backup retention** | `BACKUP_RETENTION_DAYS` (default 7 d) | backup container prune |

## Monitor freshness

```bash
# any user with monitoring:read
curl -s $API/v1/ops/backups/status | jq
# → { bucket, count, latestKey, latestAt, ageHours, rpoHours, fresh }
```

`fresh: false` (or `count: 0`) means the newest dump is older than the RPO window
(or none exist) — **investigate the backup container immediately**
(`docker compose logs postgres-backup`). A Prometheus gauge + Alertmanager rule
on this signal is a follow-on (ADR-0074).

## Restore drill (rehearse quarterly)

1. Confirm a fresh backup: `GET /v1/ops/backups/status` → `fresh: true`.
2. (Drill only) restore into a scratch DB and run the e2e auth suite — the P0.5
   drill: `seed → backup → wipe → restore → suite green`.
3. Production restore:
   ```bash
   pnpm db:restore <key|latest>     # TTY confirm; CONFIRM_RESTORE=yes for scripted
   ```
4. Verify: login, create an incident, confirm audit rows **seal + anchor**
   (`GET /v1/audit/anchor/status`) — the tamper-evident chain survived the restore.

## Full-host rebuild (hardware loss)

Single-site = the host itself is the single point of failure. To rebuild on new
hardware **offline**:

1. Use the air-gap bundle (P5.8 / ADR-0073): transfer → `verify-bundle.sh` →
   `install.sh` (loads images, brings the stack up, applies migrations).
2. Restore the latest dump from the backups bucket (step 3 above). Keep the
   backups bucket (MinIO) on **separate storage/media** from the app host so a
   host loss doesn't take the backups with it — the one place single-site DR
   genuinely depends on physical separation.

## Warm standby (optional, single-site)

The replica/Sentinel profiles (P3.13 / ha.md) provide a Postgres read replica +
Redis Sentinel on the same site — faster recovery from a *process/instance*
failure (not a site loss). Promote per `docs/runbooks/ha.md`.

## What this is NOT

- **Not** multi-region active-active (P5.7 — impossible single-site).
- **Not** PITR/zero-RPO (WAL streaming is a follow-on if the posture is upgraded).
- Freshness ≠ restorability — add a periodic **test-restore** (ADR-0074 follow-on)
  for the stronger guarantee.
