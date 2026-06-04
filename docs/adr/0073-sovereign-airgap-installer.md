# ADR-0073: Sovereign / air-gapped installer — docker-save bundle + SHA-256 manifest

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P5.8 (sovereign / airgapped installers) — Horizon P5
**Builds on:** docker-compose stack (deploy/data/observability), backups (P0.5), HA profiles (P3.13)
**Context note:** P5.7 (multi-region active-active) was marked **N/A** (single-site reality) the same day.

## Context

The КЧС deployment is **sovereign + single-site** and may sit on a network that
**cannot reach the public internet** (no Docker Hub, no package mirrors). It
needs a repeatable way to install + upgrade the platform fully offline. The whole
stack already runs on `docker compose`, so the pragmatic offline unit is a
**`docker save` image bundle + the compose files + scripts**, not a private
registry or a k8s offline distribution.

Forks locked with the user: **docker images tar + compose + scripts** (not an
OCI registry mirror); **full stack** in one bundle (all containers, incl.
observability); integrity via **SHA-256 manifest + a verify step** (no
cosign/GPG signing — no key material to manage on-site).

## Decision

Three shell tools under `infra/airgap/` + a runbook.

### `build-bundle.sh` (connected build host)

`git describe` → version → builds the from-source images (`api`, `web`, custom
`postgres`/`backup`) → enumerates **every** image across the three compose files
(`deploy-compose.yml` + `docker-compose.yml` + `observability-compose.yml`) via
`docker compose config --images` (deduped) → `docker save | gzip` →
`images.tar.gz`; stages the compose files, an `.env.example`, `install.sh`,
`verify-bundle.sh`, `VERSION`, and the runbook; writes `MANIFEST.sha256` over
every artifact; packs `cmc-airgap-<version>.tar.gz` (+ an outer `.sha256`).
Portable hashing (`sha256sum` or `shasum -a 256`).

### `verify-bundle.sh` (offline host, pre-install)

`sha256sum -c MANIFEST.sha256` (or `shasum`) — refuses tampered/corrupt bundles
before anything is loaded. The integrity model is checksums only (sovereign, no
external trust roots / keys).

### `install.sh` (offline host)

Integrity-verify → `docker load` the images (offline) → ensure `.env` (copies the
template on first run and stops so the operator fills secrets) → start the data
plane → wait for Postgres health → apply migrations (one-shot via the api image;
`MIGRATE_CMD` override) → `compose up -d` the full stack → API `/health` smoke.

### Runbook

`docs/runbooks/sovereign-airgap-install.md`: build → transfer (with outer
checksum) → verify → configure (gated AI flags stay off unless their on-host
toolchain exists) → install → post-install smoke → upgrades → single-site DR.

## Consequences

- **Positive:** fully offline, registry-free, key-free install/upgrade that
  matches the existing compose stack; one tamper-evident artifact; the gated-seam
  architecture means the platform runs without any AI/heavy toolchain on-site
  (they enable only if their libs are present); reuses P0.5 backups + P3.13
  profiles for single-site DR.
- **Negative / trade-offs:** the bundle is **multi-GB** (`docker save` of the full
  stack — the "full stack" fork; a "core + profiles" build would shrink it);
  SHA-256 gives **integrity, not provenance** (no signature — signing is a
  follow-on if a key process is established); migrations run via the api image so
  the command is image-specific (`MIGRATE_CMD` override); building the bundle
  requires Docker + the source on a connected host.
- **Air-gap caveat:** `build-bundle.sh`'s `docker save` of the whole stack is an
  operator action on a connected host (multi-GB, minutes) — not run in CI.

## Validation

- `bash -n` syntax-checked all three scripts; the **image-enumeration** step was
  dry-run against the live compose (`docker compose config --images` → the full
  resolved image set incl. the built `cmc/api`, `cmc/web`, `cmc/postgres`,
  `cmc/postgres-backup`). Infra/ops scripts (like P3.13 HA, P0.5 backups) are
  validated by syntax + dry-run + runbook review, not jest. No app code changed →
  the backend suite is untouched.
- **Boundary:** a real end-to-end offline build → transfer → install on a fresh
  air-gapped host is a manual drill (multi-GB, Docker-on-host).

## Files

- `infra/airgap/build-bundle.sh`, `verify-bundle.sh`, `install.sh`
- `docs/runbooks/sovereign-airgap-install.md`

## Follow-ons

- Optional cosign/GPG **signing** of the bundle/images (provenance) if a sovereign
  key-management process is set up.
- A "core + optional profiles" slim build to cut bundle size.
- Backup-freshness check + RPO/RTO doc (the single-site DR follow-on from P5.7).
- A delta/upgrade bundle (only changed image layers) to shrink transfers.
