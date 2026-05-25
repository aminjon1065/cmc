#!/usr/bin/env bash
# Take a pg_dump of ${POSTGRES_DB}, upload to MinIO, prune dumps older than
# ${BACKUP_RETENTION_DAYS} days.
#
# Format: custom (-Fc, zlib level 9). pg_restore can fan out parallel jobs
# and is the documented restore path (see restore.sh).
#
# Roles are intentionally not dumped — pg_dump does not capture CREATE ROLE
# anyway, and on the same compose project they are created once by
# infra/postgres/init/02-roles.sql. Cross-cluster DR must run that init
# script before restore (documented in ADR-0012).

set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${BACKUP_BUCKET:=cmc-backups}"
: "${BACKUP_RETENTION_DAYS:=7}"

TS=$(date -u +'%Y-%m-%dT%H-%M-%SZ')
YEAR=$(date -u +'%Y')
MONTH=$(date -u +'%m')
DUMP_FILE="/tmp/cmc-${TS}.dump"
KEY="postgres/${YEAR}/${MONTH}/cmc-${TS}.dump"

log() { printf '[%s] [backup] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

cleanup() { rm -f "${DUMP_FILE}"; }
trap cleanup EXIT

log "pg_dump -h ${POSTGRES_HOST} -d ${POSTGRES_DB} → ${DUMP_FILE}"
PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
    --host="${POSTGRES_HOST}" \
    --port="${POSTGRES_PORT}" \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --format=custom \
    --compress=9 \
    --no-password \
    --file="${DUMP_FILE}"

SIZE_BYTES=$(stat -c%s "${DUMP_FILE}")
log "dump complete (${SIZE_BYTES} bytes)"

log "uploading → minio/${BACKUP_BUCKET}/${KEY}"
mc cp --quiet "${DUMP_FILE}" "minio/${BACKUP_BUCKET}/${KEY}" >/dev/null

# Tag the object with its size so `mc stat` calls don't have to compute it.
mc tag set --quiet "minio/${BACKUP_BUCKET}/${KEY}" "source=pg_dump&db=${POSTGRES_DB}&bytes=${SIZE_BYTES}" >/dev/null || true

log "rotation: removing dumps older than ${BACKUP_RETENTION_DAYS}d under minio/${BACKUP_BUCKET}/postgres/"
# mc rm --older-than uses the duration suffix accepted by mc: e.g. "7d", "168h".
# `|| true` so a sweep failure doesn't fail the whole backup run — retention
# is best-effort; the freshly uploaded dump is what matters most.
mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" \
      "minio/${BACKUP_BUCKET}/postgres/" >/dev/null 2>&1 || true

log "done — minio/${BACKUP_BUCKET}/${KEY} (${SIZE_BYTES} bytes)"
