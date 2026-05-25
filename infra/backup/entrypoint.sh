#!/usr/bin/env bash
# Entrypoint for the postgres-backup sidecar.
#
# Configures the mc alias, ensures the backup bucket exists, optionally runs
# one immediate backup, then hands off to crond for the recurring schedule.
# crond runs in the foreground so the container's lifecycle is the cron
# daemon's lifecycle.

set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"

: "${MINIO_ENDPOINT:=http://minio:9000}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"

: "${BACKUP_BUCKET:=cmc-backups}"
: "${BACKUP_RETENTION_DAYS:=7}"
: "${BACKUP_SCHEDULE_CRON:=0 3 * * *}"
: "${BACKUP_RUN_ON_START:=false}"
: "${TZ:=UTC}"

export POSTGRES_HOST POSTGRES_PORT POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
export MINIO_ENDPOINT MINIO_ROOT_USER MINIO_ROOT_PASSWORD
export BACKUP_BUCKET BACKUP_RETENTION_DAYS TZ

log() { printf '[%s] [entrypoint] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

log "configuring mc alias 'minio' -> ${MINIO_ENDPOINT}"
mc alias set --quiet minio "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null

log "ensuring bucket minio/${BACKUP_BUCKET} exists"
mc mb --ignore-existing "minio/${BACKUP_BUCKET}" >/dev/null

if [[ "${BACKUP_RUN_ON_START}" == "true" ]]; then
  log "BACKUP_RUN_ON_START=true → executing immediate backup"
  if /usr/local/bin/backup.sh; then
    log "initial backup completed"
  else
    log "WARNING: initial backup failed (continuing into scheduler)"
  fi
fi

# Cron jobs need the env that the entrypoint received; busybox crond clears
# the environment when invoking commands. We write them into /etc/environment
# and source them in the cron command line.
{
  echo "POSTGRES_HOST=${POSTGRES_HOST}"
  echo "POSTGRES_PORT=${POSTGRES_PORT}"
  echo "POSTGRES_USER=${POSTGRES_USER}"
  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
  echo "POSTGRES_DB=${POSTGRES_DB}"
  echo "MINIO_ENDPOINT=${MINIO_ENDPOINT}"
  echo "MINIO_ROOT_USER=${MINIO_ROOT_USER}"
  echo "MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}"
  echo "BACKUP_BUCKET=${BACKUP_BUCKET}"
  echo "BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS}"
  echo "TZ=${TZ}"
} > /etc/backup.env
chmod 600 /etc/backup.env

# Redirect the cron job's stdout/stderr to PID 1 so `docker logs` shows it.
mkdir -p /etc/crontabs
cat > /etc/crontabs/root <<EOF
${BACKUP_SCHEDULE_CRON} . /etc/backup.env; /usr/local/bin/backup.sh > /proc/1/fd/1 2> /proc/1/fd/2
EOF

log "schedule installed: '${BACKUP_SCHEDULE_CRON}' (TZ=${TZ})"
log "next run produced by crond; manual: docker compose exec postgres-backup /usr/local/bin/backup.sh"

# crond -f keeps it in the foreground; -l 8 sets the log level (info).
exec crond -f -l 8
