# Multi-stage image for apps/api (P0.10 / ADR-0017).
#
# Build context is the REPO ROOT (the API needs the pnpm workspace + lockfile
# to resolve @cmc/contracts and @cmc/db). Build from root:
#   docker build -f apps/api/Dockerfile -t cmc/api .
#
# Stages:
#   base   — pnpm via corepack on a Debian-slim Node (glibc, so the native
#            argon2 binary built here is ABI-compatible with the distroless
#            runtime, which is the same Debian 12 / glibc base).
#   build  — install ALL deps (frozen), build the two workspace packages and
#            the API, then `pnpm deploy` a pruned, production-only, self-
#            contained tree into /prod.
#   runtime — distroless Node 22 (no shell, no package manager, non-root by
#            default), carrying only /prod.

# ---------- base ----------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------- build ----------
FROM base AS build

# Copy just the manifests + lockfile first so the install layer caches until a
# dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

# Full install (incl. dev deps — needed to compile TS). Cache the pnpm store.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now bring in the sources and build.
COPY tsconfig*.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/api apps/api

# Workspace packages must be built first (the API imports their dist), then the
# API itself.
RUN pnpm --filter @cmc/contracts build \
 && pnpm --filter @cmc/db build \
 && pnpm --filter @cmc/api build

# Produce a pruned, production-only, self-contained deployment of the API into
# /prod. `pnpm deploy` resolves the workspace deps (@cmc/contracts, @cmc/db)
# into real node_modules entries, so the result needs no symlinks back to the
# monorepo.
RUN pnpm --filter @cmc/api --prod deploy /prod

# ---------- runtime ----------
# The `:nonroot` tag runs as uid 65532 'nonroot' (the default/`:latest` tag
# runs as ROOT — a real footgun). Pin nonroot explicitly for least privilege.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The deployed tree: node_modules (prod-only) + the built dist + package.json.
COPY --from=build --chown=nonroot:nonroot /prod /app
USER nonroot
EXPOSE 3001
# distroless/nodejs sets ENTRYPOINT ["/nodejs/bin/node"], so CMD is just args.
CMD ["dist/main.js"]
