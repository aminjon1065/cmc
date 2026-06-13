# ADR-0080: Scope reduction to a single-organization КЧС deployment

**Status:** Accepted
**Date:** 2026-06-13
**Implements:** `plan.md` Phase 0; `ToR.md` v2.0 §2 (non-goals), §4 (tenancy), §12 (deferred)
**Supersedes:** see "Superseded ADRs" below
**Depends on:** ADR-0001 (stack), ADR-0064 (regional segmentation — amended, becomes the org-scoping dimension)

## Context

The repository was generated against ToR **v1.0**: a multi-tenant, multi-region,
nationally-federated SaaS platform sized for 100k concurrent users and 10¹⁰
records, with ClickHouse, NATS/Kafka, Temporal, OpenSearch, an AI
(vector/RAG/copilot) stack, in-house video conferencing, collaborative editing, a
wiki, an API-key platform, a PWA companion, a SOC2 control program, and a heavy
observability stack (OTel tracing + Loki + Tempo). That produced ~42 NestJS
modules and 79 ADRs.

ToR **v2.0** (now the single source of truth) redefines the product: an
**internal tool for exactly one organization** — Committee for Emergency
Situations and Civil Defense of the Republic of Tajikistan (КЧС ГО РТ) — running
on **one on-prem server**, used primarily by **analysts** and operational staff,
scoped **by region/subdivision** across the republic. There is **one tenant**.

Carrying the v1.0 infrastructure forward spends the majority of effort on
machinery that serves zero current users and makes the system harder for a small
team to operate. ToR v2.0 §2 lists what is removed and §12 records the concrete
trigger under which each removed capability may return.

This ADR records the decision to bring the live repository in line with ToR v2.0
and enumerates exactly what is removed, deferred, kept, or reworked — and which
prior ADRs are superseded.

## Decision

Reduce the build to ToR v2.0 §5 (in-scope modules) only. Concretely:

### 1. Remove multi-tenancy entirely
There is one organization, so tenant isolation solves a non-existent problem.
- Drop the `tenants` and `branding` (tenant-branding) modules + their schema.
- Remove `tenant_id` columns and tenant RLS policies from all kept tables (via
  reversible migration, backup first).
- Replace `TenantContext` / `TenantContextMiddleware` / `TenantDatabaseService` /
  `TenantTransactionInterceptor` with the existing `RequestContext` plumbing and
  a plain (non-tenant-scoped) database accessor.
- Drop tenant claims from auth tokens/sessions (amends ADR-0002).
- **Regions become the organization-scoping dimension** (ToR §4). `regions` is no
  longer "a dimension within a tenant" (ADR-0064) but the top-level access
  boundary: regional users see their region; `region:all` holders (head office)
  see all. Re-point RBAC roles from per-tenant to organization-global and reseed
  the permission catalog + system roles once.

### 2. Remove §2 non-goal modules
Delete module dir + schema, unwire from `app.module`, drop tables via reversible
migration, remove infra/compose services, prune now-unused dependencies:

| Module(s) | Reason (ToR §2 / §12) |
|---|---|
| `temporal`, `workflows` (Temporal-backed) | Durable-workflow runtime removed; approval/SLA flows are in-app DB state + scheduled jobs. |
| `llm`, `vector`, `rag`, `copilot` | AI stack (gateway/embeddings/semantic search/RAG/copilot/doc-intelligence) is a *later* goal. `pgvector` stays in Postgres so embeddings can be added later without a new datastore. |
| `collab` | Real-time collaborative editing out of scope; versioned docs + locking suffice. |
| `video`, `media` | In-house video/media pipeline removed; integrate self-hosted Jitsi later if AV becomes a requirement. |
| `api-keys` | No external API-key platform need now. |
| `wiki` | No wiki/knowledge-base need now. |
| OpenSearch + federated-search paths | Postgres FTS covers discovery at this scale. |
| Visual-workflow-builder path | Not core to the analyst mission. |

### 3. Defer ClickHouse (analytics on PostgreSQL)
Point `analytics` at PostgreSQL; remove the ClickHouse client wiring and the
`clickhouse` compose service + the audit/analytics ClickHouse projections. Keep
the projection *pattern* documented (this ADR + ADR-0033 note) for later. Returns
only when Postgres aggregation latency on real data is a measured bottleneck, as a
read-only downstream sink — never the system of record, never under EDMS.

### 4. Swap NATS → in-process events
Replace the NATS JetStream relay with the in-process Nest `EventEmitter`. Keep the
transactional-outbox seam in code but **off by default**; a network broker
returns only when a module is actually extracted into a separate service. Remove
the `nats` compose service.

### 5. Trim observability to lightweight
Keep structured logs + Prometheus metrics + health probes (ADR-0010/0014/0015).
Remove OTel distributed tracing, Loki log aggregation, and Tempo alerting (heavy
observability — ToR §2). Full tracing returns only when load justifies it.

### 6. Drop the SOC2 / enterprise-SaaS compliance program
КЧС is a single government body, not a SaaS vendor. The relevant obligations
(auditability, on-prem residency, retention) are already met by the audit
hash-chain (ADR-0029/0030/0059) and ToR §10. Remove `docs/compliance` (SOC2
control mapping + evidence register) and the sovereign-airgap installer.

### 7. Defer PWA mobile companion
Returns when field data collection on mobile is prioritized (ToR §12).

### Kept as-is (ToR §5 in-scope)
Auth, MFA, password-reset, RBAC, regions, users, audit, database/redis/storage
plumbing, incidents, cases, notifications, incident-notifications, documents,
folders, imports, gis (+ vector tile server) / geoserver OGC interop, search
(Postgres FTS), analytics (re-pointed to Postgres), chat, realtime gateway,
health/metrics/backups, openapi/versioning, web i18n/theming/preferences.
Tasks/board is **new build** (ToR §5; not yet in code) — added in Phase 3, not here.

## Superseded ADRs

**Fully superseded (capability removed or deferred):**
ADR-0013 (OTel tracing), ADR-0018 (tenant branding), ADR-0025 (Loki log
aggregation), ADR-0026 (Tempo alerting), ADR-0031 (NATS event plane), ADR-0033
(ClickHouse analytics projection), ADR-0034 (audit ClickHouse projection),
ADR-0036 (dashboards from ClickHouse), ADR-0045 (Temporal workflows), ADR-0046
(incident-response Temporal workflow), ADR-0051 (OpenSearch search), ADR-0052
(federated search), ADR-0053 (visual workflow builder), ADR-0054 (API keys),
ADR-0055 (wiki), ADR-0060 (realtime collaboration), ADR-0061 (video
conferencing), ADR-0063 (media management), ADR-0066 (realtime analytics),
ADR-0067 (LLM gateway), ADR-0068 (vector pipeline), ADR-0069 (semantic search),
ADR-0070 (RAG framework), ADR-0071 (copilot framework), ADR-0072 (document
intelligence), ADR-0073 (sovereign airgap installer), ADR-0075 (PWA companion).

**Partially superseded (capability kept; tenancy/ClickHouse aspect removed):**
ADR-0001 (stack — NATS/ClickHouse/Temporal/OpenSearch/AI/video dropped), ADR-0002
(auth — tenant context/claims dropped), ADR-0003 (sessions/refresh kept; tenant
RLS dropped), ADR-0004 (documents kept; tenant RLS dropped), ADR-0064 (regional
segmentation — amended: region is now the top-level org-scoping dimension, no
longer within-tenant).

**Decision pending (NOT auto-superseded — see Open Questions):**
ADR-0062 (operational monitoring center), ADR-0058 (HA introduction), ADR-0065
(Vault production).

Each fully-/partially-superseded ADR will get a `Superseded by ADR-0080` (or
`Amended by ADR-0080`) banner in the same commit that removes its capability.

## Resolved decisions (confirmed 2026-06-13)

The four borderline calls were put to the owner and confirmed as proposed:

1. **`monitoring` module (ADR-0062) → REMOVE.** Not in ToR §5; the "command-center
   wall" aggregates incidents + audit_log + **video-room count** (a removed
   module) and overlaps the in-scope `analytics` dashboards. Any wanted tiles are
   re-introduced under `analytics` later. ADR-0062 → Superseded.
2. **`previews` module (ADR-0043) → KEEP.** Not AV-only — renders **document
   thumbnails** (image/PDF) for the EDMS file manager. The dormant video/audio
   preview branches are dropped. ADR-0043 stays Accepted.
3. **Vault → KEEP optional loader, DEFER prod-HA, REMOVE airgap.** The dev/secret
   loader (ADR-0044) is gated **off** by default and satisfies ToR §9 "secrets
   outside source"; production-HA Vault (ADR-0065) is deferred; the
   sovereign-airgap installer (ADR-0073) is removed.
4. **HA (ADR-0058) → single-site only.** Retain process supervision / fast restart
   within one server (ToR §9); trim any multi-node/active-active clustering.

## Consequences

- **Positive:** the codebase matches the real product and team size; far fewer
  moving parts to operate and secure on one server; no infrastructure serving zero
  users; the analyst mission (data → analysis → reports, GIS, EDMS) is unobstructed.
- **Negative / trade-offs:** large deletions touch many modules; the
  multi-tenancy removal is the highest-risk step (done incrementally, tests green
  after each sub-step, reversible migrations, backup first); removed capabilities
  must be re-introduced via a new ADR with a stated trigger (ToR §2 anti-creep
  rule), never speculatively.

## Validation (to be recorded as Phase 0 executes)

- Each removal is one atomic commit; `typecheck` + `lint` + `build` + tests green
  at every commit.
- Final: full check suite green, seed script runs, migrations apply end-to-end on
  a fresh DB, the app boots on Docker Compose with the trimmed service set.

## Follow-ons

- ToR §12 deferred-features register governs all re-introductions.
- Tasks/board module (ToR §5) — built in `plan.md` Phase 3.
- Off-site backup (the one DR carry-over from single-site reality — ADR-0064).
