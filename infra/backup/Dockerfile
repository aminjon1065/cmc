# Postgres backup sidecar.
# Bundles pg16 client tools + MinIO client (mc) + busybox crond into a single
# alpine image so the backup and restore scripts have everything they need
# without depending on the host.

FROM alpine:3.20

# - postgresql16-client: pg_dump, pg_restore, psql at the same major version
#   as infra/postgres/Dockerfile (postgis/postgis:16-3.4).
# - bash: backup.sh / restore.sh / entrypoint.sh shebang.
# - curl, ca-certificates: mc download + HTTPS to MinIO if ever needed.
# - tzdata: cron schedules are interpreted in TZ (default UTC).
# - busybox already provides crond.
RUN apk add --no-cache \
        bash \
        ca-certificates \
        coreutils \
        curl \
        findutils \
        postgresql16-client \
        tzdata

# Pin mc to the same release the minio-init service uses in compose so behaviour
# is consistent across both clients (alias semantics, --older-than syntax).
ARG MC_VERSION=RELEASE.2024-11-21T17-21-54Z

RUN set -eux; \
    case "$(uname -m)" in \
        x86_64)  MC_ARCH=amd64 ;; \
        aarch64) MC_ARCH=arm64 ;; \
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://dl.min.io/client/mc/release/linux-${MC_ARCH}/archive/mc.${MC_VERSION}" \
         -o /usr/local/bin/mc; \
    chmod +x /usr/local/bin/mc; \
    mc --version

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY backup.sh     /usr/local/bin/backup.sh
COPY restore.sh    /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/backup.sh \
             /usr/local/bin/restore.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
