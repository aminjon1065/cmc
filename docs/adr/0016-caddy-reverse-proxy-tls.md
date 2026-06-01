# ADR-0016: Caddy reverse proxy + automatic TLS

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.9
**Closes tech-debt:** TD-006
**Completes follow-ons:** ADR-0014 (/metrics network restriction), ADR-0015 (/health/deep network restriction)
**Depends on:** ADR-0001 (which named "Caddy, added at deploy step")

## Context

The platform had no TLS termination and no reverse proxy — ADR-0001
listed "Reverse proxy / TLS: Caddy (added at deploy step)" and the deploy
step is now. TD-006 (S0) blocks any external deployment: without TLS the
API + web cannot be served to a browser over the internet, and there is
no single ingress to attach edge concerns (HTTPS, security headers,
ops-endpoint hiding) to.

P0.9 lands a Caddy edge as a **deploy-time compose overlay**, separate
from the core data-services compose, with automatic Let's Encrypt.

## Decision

### 1. Caddy, as a separate `deploy-compose.yml` overlay

`infra/deploy-compose.yml` (`pnpm deploy:up/down/logs/ps/validate`) is
**separate** from `infra/docker-compose.yml` (Postgres/Redis/MinIO) and
`infra/observability-compose.yml` (Prometheus/Grafana). The edge is
brought up only when deploying externally; local development needs no
proxy. Caddy chosen per ADR-0001: automatic Let's Encrypt with zero cert
plumbing, a tiny config surface, HTTP/2 + HTTP/3 out of the box.

### 2. Subdomain routing, NOT path routing (deviation from the plan text)

The plan said "forward `/v1/*` to the API, `/*` to the web." That can't
work yet and would be wrong:

- **There is no `/v1` prefix.** It lands at P1.9. The API serves bare
  paths (`/auth`, `/documents`, `/health`, `/metrics`).
- **Those paths collide with the web app.** `/documents` is *both* an API
  resource and a Next.js page (`/documents/page.tsx`). A path rule
  `/documents/* → API` would break the web page.

So routing is **host-based**:

```
{$APP_HOST}  → web   ({$APP_UPSTREAM})
{$API_HOST}  → API   ({$API_UPSTREAM})
```

This avoids the collision, needs no app-side prefix, and lets Caddy mint
a certificate per host automatically. When `/v1` arrives (P1.9) the host
split still stands — `/v1` becomes the API's internal prefix, not a
routing key. Documented here as a deliberate departure from the plan's
literal wording, honouring its intent ("put the platform behind TLS").

### 3. Fully env-driven — one Caddyfile for dev and prod

Every host + upstream + the ACME email comes from the environment
(`infra/.env.production`, git-ignored; `.example` checked in). The same
`Caddyfile` serves:

- **Local TLS smoke test:** `APP_HOST=localhost`, `API_HOST=api.localhost`
  → Caddy's **internal CA** (self-signed), no ACME, no public DNS.
- **Production:** real domains → **Let's Encrypt** (HTTP-01 / TLS-ALPN-01),
  no Caddyfile edit.

Verified live with the internal CA: certs issued for `localhost` +
`api.localhost` (`issuer=Caddy Local Authority`), HTTPS/2 proxied to the
host API returning 200, HTTP→HTTPS 308 redirect.

### 4. Operational endpoints blocked at the edge

`/metrics` (ADR-0014) and `/health/deep` (ADR-0015) are anonymous on the
app but must not be reachable from the public internet — they expose
internal RED metrics, dependency timings, and error strings. A
`(block_ops)` snippet imported into every site responds **404** to
`/metrics`, `/metrics/*`, `/health/deep`, `/health/deep/*`. Verified:
`/metrics` → 404, `/health/deep` → 404, while `/health/ready` → 200 (LBs
still see readiness). This closes the deferred network-restriction
follow-ons from both ADR-0014 and ADR-0015. Prometheus + operators reach
those endpoints on the private network / the app port directly, not
through Caddy.

### 5. Default upstreams target the host; flip to compose-DNS at P0.10

The API + web currently run on the **host** (app Dockerfiles are P0.10),
so the default upstreams are `host.docker.internal:3001` / `:3000`
(`extra_hosts: host-gateway` makes that resolve on Linux too). After
P0.10 they flip to the compose service names (`api:3001` / `web:3000`) —
a single `.env.production` edit, no Caddyfile change. The `.example`
documents this transition inline.

### 6. Security headers + compression + no header_up boilerplate

A `(common)` snippet adds HSTS (1y, includeSubDomains — Caddy only emits
it over HTTPS), `X-Content-Type-Options: nosniff`, `X-Frame-Options:
DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, strips the
`Server` header, and enables zstd/gzip. **No explicit `header_up
X-Forwarded-*`** — `caddy validate` confirmed Caddy's `reverse_proxy`
passes `X-Forwarded-For/-Proto/-Host` by default, so the API's
trust-proxy logic (P0.1) sees the real client IP without boilerplate.

### 7. Cert + ACME state persisted

`caddy_data` and `caddy_config` named volumes persist issued certificates
and the ACME account across restarts, so a redeploy reuses certs instead
of re-requesting them (which would hit Let's Encrypt rate limits). The
`.example` points to the LE **staging** CA via `CADDY_EXTRA_GLOBAL` for
pre-production testing.

## Consequences

**Positive:**

- TD-006 retired. The platform can be served over HTTPS externally — the
  last hard blocker (with backups P0.5) on a non-dev deploy.
- ADR-0014 + ADR-0015 network-restriction follow-ons closed: `/metrics`
  and `/health/deep` are unreachable from the edge.
- One ingress now owns TLS, security headers, HTTP→HTTPS redirect, and
  ops-endpoint hiding. Adding WAF / rate-limit at the edge later has a
  home.
- Same config dev→prod; local internal-CA path makes the whole thing
  testable without a domain (and it was).

**Negative / known gaps:**

- **Upstreams are `host.docker.internal` until P0.10.** Correct while
  apps run on the host; becomes compose-DNS after app Dockerfiles. Noted
  in the `.example`.
- **No edge rate-limiting / WAF yet.** ToR §3.17 calls for OWASP CRS.
  P0.1 covers auth-endpoint rate-limit at the app; a global edge limit
  and WAF are a later hardening item (the `(common)` snippet is where
  they'd attach).
- **CORS / web→API host change not wired.** The web app's
  `NEXT_PUBLIC_API_BASE_URL` still points at `localhost:3001` in dev; a
  real deploy sets it to `https://{API_HOST}` and the API's
  `CORS_ORIGINS` to `https://{APP_HOST}`. That's deploy-env config, not a
  code change — called out for the deploy runbook, not solved here.
- **mTLS service-to-service** (ToR §6.8) is out of scope — this is edge
  TLS only. Internal mesh TLS is a P4 concern.
- **HSTS preload not claimed.** The header omits `preload`; opt in only
  once the domain is committed to HTTPS-forever.

## Triggers for re-evaluation

- App Dockerfiles land (P0.10) → flip `*_UPSTREAM` to `api:3001` /
  `web:3000`; consider merging the edge into the main deploy stack.
- `/v1` prefix lands (P1.9) → no routing change needed; document that the
  API host serves `/v1/*` internally.
- External API consumers / partners arrive → add edge rate-limiting +
  OWASP CRS WAF in the `(common)` snippet (or front with Kong/Envoy per
  ToR §3.17).
- Multi-region / HA edge → move from a single Caddy container to a
  replicated edge with shared cert storage (Caddy supports a storage
  backend for clustered ACME).

## References

- [PRIORITY_EXECUTION_PLAN P0.9](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-006](../audit/TECH_DEBT_REGISTER.md)
- [ADR-0001](./0001-initial-architecture-and-stack.md) — named Caddy at deploy step
- [ADR-0014](./0014-prometheus-metrics.md) — /metrics restriction follow-on
- [ADR-0015](./0015-health-probes.md) — /health/deep restriction follow-on
- ToR §6.8 (encryption in transit), §13.1 (deploy), §3.17 (API gateway / WAF)
