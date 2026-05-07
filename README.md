# CMC — Unified Enterprise Operational Intelligence Platform

Monorepo for the platform described in [docs/ToR.md](docs/ToR.md).

## Architecture at a glance

- **apps/web** — Next.js 15 (App Router, RSC, Server Actions). UI + BFF.
- **apps/api** — NestJS (modular monolith). Domain logic, persistence, eventing.
- **packages/contracts** — Shared TypeScript types: DTOs, event schemas.
- **packages/db** — Drizzle ORM schema, migrations, query helpers.
- **infra/** — `docker-compose.yml` for local development infrastructure.
- **docs/** — Technical Requirements (`ToR.md`) and ADRs.

See [docs/adr/0001-initial-architecture-and-stack.md](docs/adr/0001-initial-architecture-and-stack.md)
for the rationale behind the stack and infrastructure decisions.

## Prerequisites

- Node.js ≥ 22 (use `nvm use` — `.nvmrc` pins the version)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- Docker ≥ 24 with Compose plugin

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Start infrastructure (Postgres+PostGIS, Redis, MinIO)
cp infra/.env.example infra/.env   # adjust if needed
pnpm infra:up

# 3. Run database migrations (once apps/api wires Drizzle)
pnpm --filter @cmc/db migrate

# 4. Start all apps in dev mode
pnpm dev
```

Then:

- **Web app:** http://localhost:3000
- **API:** http://localhost:3001
- **MinIO console:** http://localhost:9001
- **Postgres:** `localhost:5432` (user/db per `infra/.env`)

## Common commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start web + api in dev with hot reload |
| `pnpm build` | Build all workspaces |
| `pnpm typecheck` | TypeScript check across workspaces |
| `pnpm lint` | Lint across workspaces |
| `pnpm test` | Run all test suites |
| `pnpm format` | Prettier-format all files |
| `pnpm infra:up` | Start dev infrastructure containers |
| `pnpm infra:down` | Stop containers (data preserved) |
| `pnpm infra:reset` | Stop **and delete volumes** (fresh state) |
| `pnpm infra:logs` | Tail logs from all infra containers |
| `pnpm infra:ps` | Status of infra containers |

## Project conventions

- **Modular monolith.** `apps/api/src/modules/<name>/` owns its data and contracts.
  Cross-module references go through public APIs or events, never via shared tables.
- **Tenant context.** Every persisted row has `tenant_id` from day one, even if RLS
  policies are not yet enabled.
- **Idempotency.** All command handlers and event consumers are idempotent.
- **Audit by default.** State-mutating actions append to the audit log.
- **No paid third-party runtime dependencies** (see ToR §20.1 principle 11).

## Status

This is the initial skeleton. Modules are added incrementally — see ToR §17 for the
phased roadmap.
