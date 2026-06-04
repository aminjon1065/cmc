#!/usr/bin/env bash
#
# verify-bundle.sh — verify the integrity of an unpacked CMC air-gap bundle
# against its MANIFEST.sha256 BEFORE installing (P5.8 / ADR-0073). No network,
# no signing keys — just SHA-256 checksums (the chosen integrity model).
#
# Run from inside the unpacked bundle directory:  ./verify-bundle.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f MANIFEST.sha256 ] || { echo "MANIFEST.sha256 not found — wrong directory?" >&2; exit 1; }

echo "[verify] checking SHA-256 of every bundled artifact…"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c MANIFEST.sha256
else
  shasum -a 256 -c MANIFEST.sha256
fi
echo "[verify] OK — all artifacts match the manifest."
