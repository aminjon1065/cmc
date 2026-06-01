# ADR-0017: App Dockerfiles (api + web) — multi-stage, distroless, non-root

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.10
**Depends on:** ADR-0016 (Caddy edge — these images sit behind it)
**Completes:** the host-upstream → compose-DNS transition promised in ADR-0016 §5

## Context

Until now there were no runtime images for `apps/api` or `apps/web` —
deploy was an implicit `pnpm build && node dist` on the host, and the
Caddy edge (P0.9) forwarded to `host.docker.internal`. ToR §13.1 calls
for multi-stage, non-root, minimal-surface images. P0.10 lands both
Dockerfiles, wires the images into the deploy overlay, and flips Caddy's
upstreams to the compose service names.

## Decision

### 1. Multi-stage: Debian-slim build → distroless runtime

Both images use `node:22-bookworm-slim` for the build stage (full
toolchain, pnpm via corepack) and **`gcr.io/distroless/nodejs22-debian12`**
for runtime (no shell, no package manager, minimal CVE surface). The
build base and the distroless runtime are **both Debian 12 / glibc**, so
the native `argon2` binary compiled in the build stage is ABI-compatible
with the runtime — verified: the API image runs argon2-backed login.

### 2. Non-root: pin the `:nonroot` tag (real footgun)

`gcr.io/distroless/nodejs22-debian12` (the default/`:latest` tag) runs as
**root (uid 0)** — confirmed empirically (the first API image ran as uid
0). The `:nonroot` tag runs as uid 65532. Both Dockerfiles pin
`:nonroot` **and** add an explicit `USER nonroot`, with `--chown=nonroot`
on the COPY. Verified: both images run as uid 65532.

### 3. Build context is the repo root; one root `.dockerignore`

Both apps depend on workspace packages (`@cmc/contracts`, `@cmc/db`) and
the lockfile, so the build context is the monorepo root and the
Dockerfiles are referenced with `-f apps/<app>/Dockerfile .`. A single
root `.dockerignore` keeps the context lean (no node_modules, dist,
.next, tests, docs) and keeps every `.env*` out of every image.

### 4. API: `pnpm deploy --prod` for a self-contained tree

The API build installs all deps (frozen, cached pnpm store), builds the
two workspace packages then the API, and runs `pnpm --filter @cmc/api
--prod deploy /prod`. `pnpm deploy` resolves the workspace deps into real
`node_modules` entries (no symlinks back to the monorepo) and prunes dev
deps — so the runtime image carries only `/prod` (built `dist` +
production `node_modules`). Runtime is `node dist/main.js` (distroless
sets `ENTRYPOINT ["/nodejs/bin/node"]`, so `CMD ["dist/main.js"]`).

(Note: `pnpm deploy` currently also copies the package's source files
into `/prod`; harmless but slightly fat — a future tightening can prune
them. Image is ~403 MB, dominated by argon2 + aws-sdk + Node.)

### 5. Web: Next.js standalone output

`apps/web/next.config.ts` gains `output: "standalone"` +
`outputFileTracingRoot` = repo root. `next build` traces exactly the
files the server needs into `.next/standalone`; the runtime image copies
that tree + `.next/static` + `public`, and runs `node apps/web/server.js`
(the server entry is under `apps/web/` because the trace root is the
monorepo root). No full `node_modules` at runtime. Image ~321 MB.

**`NEXT_PUBLIC_*` is a build-arg, not runtime env** — Next inlines those
into the client bundle at build time. `NEXT_PUBLIC_API_BASE_URL` is a
Docker `--build-arg` (the deploy overlay passes
`https://${API_HOST}`); server-side calls (Auth.js) use the runtime
`API_BASE_URL` (`http://api:3001` inside the deploy network).

### 6. Deploy overlay now runs api + web; upstreams flipped

`infra/deploy-compose.yml` gains `api` + `web` services (built from the
Dockerfiles). Caddy's upstream defaults flip from `host.docker.internal`
to the compose service names (`api:3001` / `web:3000`) — the transition
ADR-0016 §5 promised. The `api` service joins the **external `cmc-net`**
network (from `infra/docker-compose.yml`) so it reaches postgres / redis
/ minio by service name. Deploy order: `pnpm infra:up` (core) then
`pnpm deploy:up` (api + web + Caddy).

Healthchecks use the distroless-bundled node (`fetch(...)`) for api/web;
Caddy probes its own `:80` listener (the admin `:2019` API is disabled by
default — probing it gave false "unhealthy").

### 7. Config hardening: empty env vars treated as unset

The full-stack bring-up surfaced a real bug: compose passes
`OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) when no collector is set, and the
zod schema's `.url().optional()` accepts `undefined` but **rejects an
empty string** — so the API crash-looped with "Invalid url". Fixed with
an `emptyAsUndefined` zod preprocessor applied to the optional URL vars:
`""` / whitespace → `undefined` ("no collector"), a real URL still
validates, a malformed non-empty value still throws. Guarded by
`config.e2e-spec.ts` (4 tests). This is the one application-code change
in P0.10 and the reason the suite grew 73 → 77.

## Consequences

**Positive:**

- Both apps ship as pinned, reproducible, **non-root**, distroless images
  — ToR §13.1's core asks (multi-stage, minimal, non-root) met.
- The whole platform now runs containerised behind TLS. Validated
  end-to-end: `pnpm infra:up` + `pnpm deploy:up` → Caddy → API `/health`
  200 (HTTP/2), `/health/ready` 200 with **all deps up incl. minio via
  service name**, `/metrics` 404 (edge-blocked), web 200. All three
  containers healthy.
- The earlier host-published-MinIO "socket hang up" disappears on the
  shared `cmc-net` (service-name addressing) — confirming it was a host
  topology quirk, not an app bug.
- The empty-env config fix hardens every optional-URL var against the
  `VAR=` idiom, not just OTEL.

**Negative / known gaps:**

- **No image scanning yet** (Trivy / Grype / SBOM). ToR §13.1 + §13.14
  call for it; tracked as TD-029. Distroless already minimises the
  surface; scanning in CI is the follow-on.
- **`pnpm deploy` copies app source into the API image.** Harmless,
  slightly fat. A future `--no-...` / prune step trims it.
- **Images not built in CI / not pushed to a registry.** P0.10 is the
  Dockerfiles + local build validation; a CI build-and-push pipeline is a
  later deploy-automation item.
- **Image sizes (~403 / ~321 MB)** are reasonable but not minimal —
  dominated by native/SDK deps. Acceptable; revisit if pull time matters.
- **Secrets via env** still (JWT_SECRET, AUTH_SECRET, DB creds). The
  images bake none, but the deploy passes them as compose env. Vault
  integration is P2.14 (TD-005).
- **Web `NEXT_PUBLIC_API_BASE_URL` is build-time baked** — a different
  API host needs a rebuild. Inherent to Next's public-env model;
  acceptable since the API host is a deploy-time constant.

## Triggers for re-evaluation

- CI image pipeline → build both images on tag, scan with Trivy + emit an
  SBOM (closes TD-029 for images), push to a registry.
- Image pull time becomes a problem → prune `pnpm deploy` source copy;
  consider `node:22-bookworm-slim`-only if distroless debugging friction
  outweighs the surface win.
- Vault lands (P2.14) → source JWT/AUTH/DB secrets from Vault instead of
  compose env.
- k8s deploy → translate the compose services to Deployments; the
  liveness/readiness probes (P0.8) and non-root images map directly.

## References

- [PRIORITY_EXECUTION_PLAN P0.10](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0016](./0016-caddy-reverse-proxy-tls.md) — the edge these sit behind
- [TECH_DEBT_REGISTER TD-029](../audit/TECH_DEBT_REGISTER.md) — image scanning
- ToR §13.1 (Docker: multi-stage, distroless, non-root, scanned, SBOM)
