# Runbook: Sovereign / air-gapped installation (P5.8 / ADR-0073)

Install the CMC platform on an **offline, single-site** host (the КЧС head
office) with **no internet access**, no external registry, and no signing keys —
using a self-contained bundle whose integrity is checked by SHA-256.

> Reality this serves: server + backups co-located at the head office, no second
> datacentre, no GPU (P4.6/P4.7). All heavy AI substrates (LLM, vector serving,
> OCR) are **gated off by default** and stay off unless their on-host toolchain
> is installed — the platform runs fully without them.

## 0. Prerequisites (offline host)

- Docker Engine + the `docker compose` plugin installed.
- Enough disk for the image set (`images.tar.gz` is multiple GB) + volumes.
- `bash`, `tar`, `gzip`, `curl`, and `sha256sum` (or `shasum`).

## 1. Build the bundle (on an internet-connected build host)

```bash
infra/airgap/build-bundle.sh            # → airgap-out/cmc-airgap-<version>.tar.gz (+ .sha256)
```

It builds the app + custom images, `docker save`s the **full stack** (app, data
plane, observability), stages the compose files + `.env.example` + on-site
scripts, and writes `MANIFEST.sha256`.

## 2. Transfer

Move `cmc-airgap-<version>.tar.gz` **and** its `.sha256` to the offline host
(removable media / one-way diode). On arrival, confirm the outer checksum:

```bash
sha256sum -c cmc-airgap-<version>.tar.gz.sha256
tar xzf cmc-airgap-<version>.tar.gz && cd cmc-airgap-<version>
```

## 3. Verify integrity

```bash
./verify-bundle.sh        # checks every artifact against MANIFEST.sha256
```

Do **not** proceed if verification fails.

## 4. Configure

```bash
cp .env.example .env      # (install.sh also does this on first run)
$EDITOR .env
```

Fill at minimum: database/redis/S3 endpoints + credentials, the JWT secrets,
`MFA_ENC_KEY`, the public URL, and `AUDIT_ANCHOR_LOCK_MODE=COMPLIANCE` for prod.
Leave the gated AI flags (`LLM_ENABLED`, `VECTOR_ENABLED`, `DOC_EXTRACT_ENABLED`,
`OPENSEARCH_ENABLED`, …) **off** unless their toolchain is present on the host.

## 5. Install

```bash
./install.sh              # verify → load images → data plane → migrate → full stack → health smoke
```

- Migrations run via the api image; override with `MIGRATE_CMD=…` if your image
  exposes a different command.
- The script waits for Postgres health before migrating and for the API `/health`
  probe at the end.

## 6. Post-install

- `docker compose -f compose/docker-compose.yml -f compose/deploy-compose.yml -f compose/observability-compose.yml ps`
- Verify backups are running + fresh (P0.5; the DR follow-on adds a freshness check).
- Smoke a login + an incident create; confirm audit rows seal/anchor.

## Upgrades

Build a new bundle on the connected host, transfer + verify, `docker load` the
new `images.tar.gz`, then `install.sh` (it re-applies migrations idempotently and
recreates changed containers). Keep the previous bundle for rollback.

## Disaster recovery (single-site)

This is **not** multi-region active-active (impossible single-site — P5.7 N/A).
The single-site DR posture is: nightly Postgres dumps to MinIO (P0.5) +
`pnpm db:restore`, the replica/Sentinel profiles (P3.13), and this bundle for a
clean rebuild. RPO/RTO + a backup-freshness check are tracked as a follow-on.
