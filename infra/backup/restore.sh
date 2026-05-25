#!/usr/bin/env bash
# Restore a Postgres backup taken by backup.sh.
#
# Usage (inside the sidecar container):
#   restore.sh <key>           # explicit key, e.g. postgres/2026/05/cmc-...-Z.dump
#   restore.sh latest          # newest dump under postgres/
#
# Behaviour:
#   1. Resolve the key (or "latest" → newest object under postgres/).
#   2. Download the dump to /tmp.
#   3. Terminate all sessions on POSTGRES_DB.
#   4. DROP DATABASE + CREATE DATABASE (so the restore lands in a guaranteed
#      empty target — the "fresh container" promise from P0.5).
#   5. pg_restore with --exit-on-error.
#
# This is destructive. The script requires CONFIRM_RESTORE=yes in the
# environment unless stdin is a TTY (in which case it prompts).

set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${BACKUP_BUCKET:=cmc-backups}"

KEY_ARG="${1:-}"

log() { printf '[%s] [restore] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "FATAL: $*"; exit 1; }

usage() {
  cat >&2 <<EOF
Usage: restore.sh <key|latest>

  <key>     full object key under the backup bucket
            (e.g. postgres/2026/05/cmc-2026-05-25T03-00-00Z.dump)
  latest    newest object under postgres/

Environment:
  CONFIRM_RESTORE=yes       skip the interactive confirmation (required when
                            stdin is not a TTY, e.g. compose exec -T)
EOF
  exit 1
}

[[ -z "${KEY_ARG}" ]] && usage

# ---------- resolve key ----------
if [[ "${KEY_ARG}" == "latest" ]]; then
  log "resolving newest dump under minio/${BACKUP_BUCKET}/postgres/"
  # mc find prints one full path per match. Sort lexicographically — keys are
  # timestamped ISO-8601-UTC, so sort order == chronological order.
  KEY_PATH=$(mc find "minio/${BACKUP_BUCKET}/postgres/" --name '*.dump' 2>/dev/null \
              | sort | tail -n 1 || true)
  [[ -z "${KEY_PATH}" ]] && die "no dumps found under minio/${BACKUP_BUCKET}/postgres/"
  log "latest = ${KEY_PATH}"
else
  KEY_PATH="minio/${BACKUP_BUCKET}/${KEY_ARG}"
  log "explicit key = ${KEY_PATH}"
  mc stat --quiet "${KEY_PATH}" >/dev/null 2>&1 \
    || die "object not found: ${KEY_PATH}"
fi

# ---------- confirm ----------
if [[ "${CONFIRM_RESTORE:-no}" != "yes" ]]; then
  if [[ -t 0 ]]; then
    printf 'About to DROP and restore database "%s" on %s:%s.\n' \
           "${POSTGRES_DB}" "${POSTGRES_HOST}" "${POSTGRES_PORT}"
    printf 'Type the database name to confirm: '
    read -r typed
    [[ "${typed}" == "${POSTGRES_DB}" ]] \
      || die "confirmation mismatch (typed '${typed}', expected '${POSTGRES_DB}')"
  else
    die "CONFIRM_RESTORE=yes required when stdin is not a TTY (got '${CONFIRM_RESTORE:-no}')"
  fi
fi

# ---------- download ----------
DUMP_FILE="/tmp/$(basename "${KEY_PATH}")"
cleanup() { rm -f "${DUMP_FILE}"; }
trap cleanup EXIT

log "downloading → ${DUMP_FILE}"
mc cp --quiet "${KEY_PATH}" "${DUMP_FILE}" >/dev/null

# ---------- drop + recreate target ----------
PSQL_ADMIN=(env PGPASSWORD="${POSTGRES_PASSWORD}" psql
            --host="${POSTGRES_HOST}"
            --port="${POSTGRES_PORT}"
            --username="${POSTGRES_USER}"
            --dbname=postgres
            --no-password
            -v ON_ERROR_STOP=1
            --quiet)

log "terminating sessions on ${POSTGRES_DB}"
"${PSQL_ADMIN[@]}" -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();
" >/dev/null || true

log "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\""
"${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";"

log "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\""
"${PSQL_ADMIN[@]}" -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"

# ---------- restore ----------
log "pg_restore --exit-on-error → ${POSTGRES_DB}"
PGPASSWORD="${POSTGRES_PASSWORD}" pg_restore \
    --host="${POSTGRES_HOST}" \
    --port="${POSTGRES_PORT}" \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --no-password \
    --exit-on-error \
    "${DUMP_FILE}"

log "done — ${POSTGRES_DB} restored from $(basename "${KEY_PATH}")"
