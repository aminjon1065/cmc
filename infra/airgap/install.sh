#!/usr/bin/env bash
#
# install.sh — install the CMC platform from an air-gapped bundle (P5.8 / ADR-0073).
# Run on the offline КЧС host, from inside the unpacked bundle directory.
#
# Steps: integrity-verify → load images → ensure .env → start data plane →
# migrate → start app + observability → health smoke. Single-site, no internet.
#
# Env overrides:
#   MIGRATE_CMD   command run inside the api image to apply migrations
#                 (default: "pnpm --filter @cmc/db migrate")
#   SKIP_VERIFY=1 skip the SHA-256 integrity check (NOT recommended)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE=(-f compose/docker-compose.yml -f compose/deploy-compose.yml -f compose/observability-compose.yml --env-file .env)
MIGRATE_CMD="${MIGRATE_CMD:-pnpm --filter @cmc/db migrate}"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"

# 1. Integrity gate (SHA-256 manifest).
if [ "${SKIP_VERIFY:-0}" != "1" ]; then
  log "verifying bundle integrity…"
  ./verify-bundle.sh || die "integrity check FAILED — do not install this bundle"
fi

# 2. Load every image into the local docker engine (offline).
log "loading container images (offline)…"
gunzip -c images.tar.gz | docker load

# 3. Config: the operator must provide a filled .env before first install.
if [ ! -f .env ]; then
  cp .env.example .env
  die "created .env from template — fill in secrets/hosts per the runbook, then re-run"
fi

# 4. Data plane first, so the DB is up before migrations.
log "starting data plane (postgres, redis, minio, …)…"
docker compose "${COMPOSE[@]}" up -d postgres redis minio
log "waiting for postgres to be healthy…"
for _ in $(seq 1 60); do
  if docker compose "${COMPOSE[@]}" exec -T postgres pg_isready >/dev/null 2>&1; then break; fi
  sleep 2
done

# 5. Apply migrations (one-shot, via the api image).
log "applying database migrations: $MIGRATE_CMD"
docker compose "${COMPOSE[@]}" run --rm --no-deps api sh -lc "$MIGRATE_CMD" \
  || die "migrations failed — see the runbook (MIGRATE_CMD override)"

# 6. Bring the rest of the stack up (app, observability, gateway).
log "starting the full stack…"
docker compose "${COMPOSE[@]}" up -d

# 7. Health smoke.
log "waiting for the API health probe…"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/health >/dev/null 2>&1 \
     || curl -fsS http://localhost/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] && log "API is healthy ✅" || log "API health not confirmed — check 'docker compose ${COMPOSE[*]} logs api'"

log "install complete. Manage with: docker compose ${COMPOSE[*]} ps|logs|down"
