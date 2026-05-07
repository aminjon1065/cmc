# ADR-0001: Initial architecture and stack

**Status:** Accepted
**Date:** 2026-05-08

## Context

We are starting implementation of the platform described in [ToR.md](../ToR.md) under
two hard constraints that diverge from the original ToR:

1. **Team size:** one human engineer + AI assistant. No dedicated DevOps, SRE, or QA roles.
2. **Infrastructure target:** Docker Compose on a self-hosted server. No Kubernetes,
   no managed cloud services, no per-call third-party billed dependencies (per ToR §20.1
   principle 11).

Platform feature scope from ToR remains intact as the long-term target. The constraints
above only narrow the *infrastructure and operational complexity*, not the product surface.

## Decision

### Repository structure

A single git monorepo using **pnpm workspaces + Turborepo** for build orchestration:

```
cmc/
├── apps/
│   ├── web/              Next.js 15 (UI + BFF, App Router)
│   └── api/              NestJS (modular-monolith backend)
├── packages/
│   ├── contracts/        Shared TS types — DTOs, event schemas
│   └── db/               Drizzle ORM schema + migrations
├── infra/
│   └── docker-compose.yml  Postgres+PostGIS, Redis, MinIO
└── docs/
    ├── ToR.md            Long-term technical spec
    └── adr/              Architecture Decision Records
```

### Stack

| Layer | Choice | Rationale |
|---|---|---|
| Frontend / BFF | **Next.js 15** (App Router, RSC, Server Actions) | Single full-stack framework reduces solo-dev surface area |
| Backend | **NestJS 10** (modular monolith) | Matches ToR; module boundaries enforceable via lint rules |
| Language | TypeScript 5.x strict everywhere | One language across the stack |
| ORM | **Drizzle ORM** | Closer to SQL, better PostGIS ergonomics than Prisma |
| OLTP DB | **PostgreSQL 16** with **PostGIS 3.4** and **pgvector** | One DB covers OLTP + spatial + vector for the foreseeable future |
| Cache / queues | Redis 7 | Standard, low-friction |
| Object storage | MinIO single-node | S3-compatible, replaceable with cloud S3 with no code change |
| Auth (web) | **Auth.js (NextAuth)** | Sessions + OAuth providers; offloads session UI |
| Auth (api) | NestJS guard validating JWT issued by Auth.js | Standard JWT bearer pattern |
| Build orchestration | Turborepo | Incremental builds across workspace |
| Container runtime | Docker Compose | Single-host orchestration, no K8s |
| Reverse proxy / TLS | Caddy (added at deploy step) | Automatic Let's Encrypt |

### Deferred (added when a module first needs it)

- **NATS JetStream** — added with the first module that needs cross-module events
  (likely Phase 1 audit projection).
- **ClickHouse** — added when analytics workload exceeds Postgres material-view capability.
- **OpenSearch** — added when full-text needs go beyond Postgres `tsvector`/`pg_trgm`.
- **LiveKit (WebRTC SFU)** — added in Phase 4.
- **Vector DB (Qdrant)** — initially pgvector; promoted only when scale demands.

### Not used (per ToR §20.1 principle 11)

- Kubernetes, Argo CD, Helm, Istio.
- Any per-call billed third-party API (LLM providers, OCR services, SMS, paging SaaS).
- Managed cloud services that lock the platform to a vendor.

## Consequences

**Positive:**
- One developer can hold the whole architecture in their head.
- One `docker compose up` reproduces the full dev environment.
- Migration path to multi-server / K8s / managed services is preserved by keeping
  module boundaries and event contracts clean from day one.

**Negative:**
- Single-host deployment is a single point of failure until DR is added.
- Vertical scaling ceiling: ~one strong VPS or dedicated server.
- Some ToR features (multi-region active-active, sovereign multi-DC) require a
  later infrastructure transition; this is accepted.

## Migration triggers

Trigger a re-evaluation of this ADR when **any** of the following becomes true:
- Concurrent users > 1000.
- Postgres single-instance write throughput becomes the bottleneck.
- Team grows past 3 engineers.
- A second customer/tenant requires deployment isolation that Compose cannot satisfy.
