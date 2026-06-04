#!/usr/bin/env bash
#
# build-bundle.sh — build a self-contained, offline (air-gapped) install bundle
# for the CMC platform (P5.8 / ADR-0073).
#
# Produces a single `cmc-airgap-<version>.tar.gz` containing:
#   - images.tar.gz   : every container image of the FULL stack (docker save)
#   - compose/*.yml   : the deploy + data + observability compose files
#   - .env.example    : the config template the operator fills in on-site
#   - install.sh, verify-bundle.sh : on-site scripts
#   - MANIFEST.sha256 : SHA-256 of every bundled artifact (integrity, no signing)
#   - VERSION, README : provenance + the runbook pointer
#
# Run this ONCE on an internet-connected build host. Transfer the resulting
# tarball to the air-gapped КЧС site and run install.sh there. No registry, no
# internet, no signing keys required (the fork: "images tar + compose + scripts",
# "full stack", "SHA-256 manifest + verify").
#
# Usage:  infra/airgap/build-bundle.sh [OUTPUT_DIR]   (default: ./airgap-out)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$ROOT/airgap-out}"
VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo "unknown")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$OUT_DIR/cmc-airgap-$VERSION"

COMPOSE_FILES=(
  "infra/deploy-compose.yml"        # app (cmc/api, cmc/web) + caddy + pgbouncer
  "infra/docker-compose.yml"        # data plane: postgres, redis, minio, opensearch, nats, clickhouse, temporal, vault...
  "infra/observability-compose.yml" # prometheus, grafana, loki, tempo, alertmanager, promtail
)

log() { printf '\033[1;34m[airgap]\033[0m %s\n' "$*"; }

# Portable SHA-256 (Linux: sha256sum; macOS: shasum -a 256).
sha256_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  else shasum -a 256 "$@"; fi
}

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

log "building bundle for version $VERSION at $STAMP"
rm -rf "$STAGE"
mkdir -p "$STAGE/compose"

# 1. Build the images that are built from source (app + custom data images).
log "building app + custom images (api, web, postgres, backup)…"
docker compose -f "$ROOT/infra/deploy-compose.yml" build
docker compose -f "$ROOT/infra/docker-compose.yml" build

# 2. Enumerate EVERY image referenced across the full stack (deduped).
log "enumerating images across the full stack…"
mapfile -t IMAGES < <(
  for f in "${COMPOSE_FILES[@]}"; do
    docker compose -f "$ROOT/$f" config --images 2>/dev/null || true
  done | sort -u | grep -v '^[[:space:]]*$'
)
[ "${#IMAGES[@]}" -gt 0 ] || { echo "no images found — is docker compose configured?" >&2; exit 1; }
printf '%s\n' "${IMAGES[@]}" > "$STAGE/images.list"
log "found ${#IMAGES[@]} images:"; printf '  - %s\n' "${IMAGES[@]}"

# 3. Save them all into one gzipped tar (this is the big artifact).
log "docker save → images.tar.gz (this can take a while + many GB)…"
docker save "${IMAGES[@]}" | gzip > "$STAGE/images.tar.gz"

# 4. Stage the compose files, env template, and on-site scripts.
for f in "${COMPOSE_FILES[@]}"; do cp "$ROOT/$f" "$STAGE/compose/"; done
# Bundle whatever env templates exist; the runbook documents the required vars.
for env in "$ROOT/.env.example" "$ROOT/apps/api/.env.example"; do
  [ -f "$env" ] && cp "$env" "$STAGE/.env.example" && break
done
[ -f "$STAGE/.env.example" ] || echo "# Fill per docs/runbooks/sovereign-airgap-install.md" > "$STAGE/.env.example"
cp "$ROOT/infra/airgap/install.sh" "$STAGE/"
cp "$ROOT/infra/airgap/verify-bundle.sh" "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/verify-bundle.sh"

cat > "$STAGE/VERSION" <<EOF
version=$VERSION
built_at=$STAMP
images=${#IMAGES[@]}
EOF
cp "$ROOT/docs/runbooks/sovereign-airgap-install.md" "$STAGE/README.md" 2>/dev/null || true

# 5. Integrity manifest (SHA-256 of every bundled file). Verified before install.
log "writing MANIFEST.sha256…"
( cd "$STAGE" && find . -type f ! -name MANIFEST.sha256 | sort | while read -r f; do
    sha256_cmd "$f"
  done > MANIFEST.sha256 )

# 6. Final tarball.
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/cmc-airgap-$VERSION.tar.gz"
log "packing $TARBALL…"
tar -C "$OUT_DIR" -czf "$TARBALL" "cmc-airgap-$VERSION"
sha256_cmd "$TARBALL" > "$TARBALL.sha256"

log "done → $TARBALL"
log "transfer it + its .sha256 to the air-gapped host, then: tar xzf …, cd cmc-airgap-$VERSION, ./install.sh"
