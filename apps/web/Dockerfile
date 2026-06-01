# Multi-stage image for apps/web (P0.10 / ADR-0017).
#
# Build context is the REPO ROOT (web depends on the @cmc/contracts workspace
# package + the lockfile). Build from root:
#   docker build -f apps/web/Dockerfile -t cmc/web .
#
# Uses Next.js standalone output (output:"standalone" in next.config.ts):
# `next build` traces exactly the files the server needs into
# .next/standalone, so the runtime image carries a minimal server + only the
# node_modules it actually imports — no full install at runtime.
#
# NEXT_PUBLIC_* values are inlined into the client bundle AT BUILD TIME, so the
# API base URL is a build-arg, not a runtime env. Override per environment:
#   docker build --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com ...

# ---------- base ----------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------- build ----------
FROM base AS build

# Manifests + lockfile first for a cacheable install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Sources.
COPY tsconfig*.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web

# The web bundle inlines this at build time.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

# contracts is transpiled by Next (transpilePackages), so it doesn't need a
# separate build — but building it keeps types resolvable and is cheap.
RUN pnpm --filter @cmc/contracts build \
 && pnpm --filter @cmc/web build

# ---------- runtime ----------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next standalone layout. `outputFileTracingRoot` is the repo root, so the
# standalone tree is rooted there: the server entry is apps/web/server.js and
# node_modules sit at the standalone root.
COPY --from=build --chown=nonroot:nonroot /repo/apps/web/.next/standalone ./
# Static assets + public are NOT traced into standalone — copy them explicitly
# to the paths the standalone server expects.
COPY --from=build --chown=nonroot:nonroot /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nonroot:nonroot /repo/apps/web/public ./apps/web/public

USER nonroot
EXPOSE 3000
# distroless/nodejs ENTRYPOINT is node; the standalone server entry lives at
# apps/web/server.js (because the trace root is the monorepo root).
CMD ["apps/web/server.js"]
