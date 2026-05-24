# SCALABILITY REVIEW
## Current ceilings and forward-looking capacity readiness

**Audit date:** 2026-05-24
**Reference horizons:**
- ToR §1.6 Horizon-1 — 10²–10³ users, 10⁶ records, single region
- Horizon-2 — 10⁴ users, 10⁸ records, multi-region active-passive
- Horizon-3 — 10⁵ users, 10¹⁰ records, multi-region active-active

**TL;DR:** the current codebase is **architecturally capable of carrying Horizon-1** with the additions named in [PRIORITY_EXECUTION_PLAN P0–P1](./PRIORITY_EXECUTION_PLAN.md). It is **structurally absent of Horizon-2 substrate** (event bus, OLAP, WS gateway, HA). Horizon-3 is **not a today-conversation** but the modular-monolith posture preserves the option without rewrite, per ADR-0001.

---

## 1. Compute tier

### 1.1 Topology

- **One API process** (NestJS).
- **One web process** (Next.js).
- **No worker tier** — all work is request-bound.

### 1.2 Stateless?

- API: **yes** — all per-request state lives in `AsyncLocalStorage` + the DB transaction.
- Web: **yes** — Next.js Server Components + Auth.js cookies.

Stateless services scale horizontally trivially **once a load-balancer is in front of them**. The platform has no load balancer today (single instance). ToR §15.1 requires sticky sessions for WebSocket; the WS gateway doesn't exist yet.

### 1.3 Connection pool

`createDatabase(url, { max: 20, idleTimeout: 30 })` in `apps/api/src/modules/database/database.module.ts`.

- **20 connections per API instance** × **1 instance** = 20 total.
- Postgres in compose is configured for `max_connections=200`.
- Headroom: 10× current instance capacity.

**Capacity ceiling:** with the global transaction interceptor, **every authenticated request holds one connection** until the controller returns. If a request takes 100 ms on average, this instance can sustain **200 RPS** of authenticated traffic before queueing on the pool.

Beyond ~5–10 instances we hit the 200-conn Postgres ceiling without PgBouncer. **PgBouncer transaction-pooling** is the standard remedy (Roadmap P2.x). Once in place, the per-instance count can drop to 4–8 and Postgres can serve 100× the instances.

### 1.4 Per-request cost (approx, hot path)

- Middleware: 1 Postgres SELECT on `sessions(id, user_id, tenant_id, revoked_at, expires_at)` — indexed lookup, sub-ms.
- Interceptor: open transaction, run `set_config('app.tenant_id', ?, true)`.
- Handler: typically 1–3 queries.
- Total: ~5–10 ms per request on a warm pool.

**Optimisation queue (P0.4):** cache session-active in Redis with TTL = access-token lifetime. Cuts middleware to a Redis GET (~½ ms). Required for ~1000 QPS sustained.

### 1.5 Stateless boundary check

| State | Lives in | Survives restart |
|---|---|---|
| Active sessions | Postgres `sessions` table | ✅ |
| Tenant context | `AsyncLocalStorage`, request-scoped | n/a |
| In-flight refresh dedup | `Map` in `apps/web/src/auth.ts` | ❌ — per-process. **Risk** when there are two web instances: both might rotate the same token. Move to Redis at multi-instance time. |
| Rate-limit counters | (not yet implemented) | will be Redis |
| Upload progress | XHR in browser | n/a |
| Audit batch buffers | (none — direct write) | n/a |

**Single non-stateless leak**: web `refreshInFlight` Map. **Tolerable today** (single web instance); **must be Redis** before scaling out web.

---

## 2. Storage tier

### 2.1 Postgres

| Metric | Today | Headroom |
|---|---|---|
| Instances | 1 | — |
| `max_connections` | 200 | 10× current API |
| `shared_buffers` | 512 MB | tune to ~25 % of host RAM |
| `effective_cache_size` | 1536 MB | tune to ~50 % of host RAM |
| Replication | None | — |
| Backups | None | — (TD-004) |

**Capacity for Horizon-1 (10³ users):**
- ~10³ users × ~5 active sessions × 1 row = 5×10³ session rows.
- ~10³ users × ~10 docs/day × 365 days = 3.6×10⁶ document rows / year.
- Audit ~10× the document volume = 3.6×10⁷ audit rows / year.
- All within single-instance comfort. **No partitioning needed for H1.**

**Capacity for Horizon-2 (10⁴ users):**
- ~10⁸ audit rows / year. Single-table reads remain fine with the `(tenant_id, occurred_at)` index but write throughput will need partitioning. **Range partition by month is the standard fix.**
- Spatial features volume depends on the GIS workload — placeholder until §4.

**Capacity for Horizon-3 (10⁵ users):**
- 10⁹+ audit rows / year. **Audit moves to ClickHouse** (ToR §3.15 already prescribes this); Postgres keeps last-N-days hot.
- Sharding via Citus when the single-node ceiling is reached (ToR §15.1).

### 2.2 Index quality

Indexes today (see `packages/db/migrations/*`):

| Table | Indexes | Quality |
|---|---|---|
| `tenants` | btree on `slug` (unique) | OK |
| `users` | btree on `tenant_id`, unique `(tenant_id, email)` | OK |
| `sessions` | btree on `tenant_id`, `user_id`, `family_id`, `(user_id, revoked_at)`, unique `refresh_token_hash` | Excellent for the rotation + list patterns |
| `audit_log` | btree on `(tenant_id, occurred_at)`, `actor_id`, `(resource_type, resource_id)` | OK; **BRIN** on `occurred_at` would be cheaper at scale |
| `documents` | btree on `(tenant_id, created_at)`, `(tenant_id, status)`, `uploaded_by` | OK; **partial `WHERE status = 'ready'`** would tighten the list query |

**Missing for scale:**
- BRIN on `audit_log.occurred_at` — append-only is the textbook BRIN case.
- GIN on `documents.tsvector(name, description)` — search is ILIKE-substring today; sequential scan inside the tenant. Acceptable up to ~10⁴ docs/tenant.
- Partial `WHERE status = 'ready'` on `documents` — most reads filter this.

### 2.3 Locking / contention hotspots

- **Family-burn UPDATE on `sessions`** runs in an autonomous tx (the burn must commit despite the request rollback). Single-family-id-prefixed UPDATE. Concurrent rotations of different families do not contend.
- **`audit_log` INSERT** — append-only; the only contention is on the table-level extension lock at very high insert rate, far above Horizon-1 ceiling.
- **`documents` finalize** — concurrent finalizes of distinct documents don't contend; concurrent finalizes of the same document are idempotent.

**No known hot row.**

### 2.4 ClickHouse

**Not present.** Mandatory for Horizon-2 dashboards (replaces the demo arrays on the dashboard with live aggregates). Mandatory for long-term audit retention (cheap columnar store, TTL to S3 cold).

### 2.5 Redis

- Deployed, password-protected, AOF on, `allkeys-lru` eviction.
- **Not used by application code today.** Capacity is irrelevant until P0.2 wires it.

Once wired (session cache, rate-limit, BullMQ for preview jobs, WS pub/sub):
- Each session-cache entry ~200 B → 10⁵ active sessions = ~20 MB. Trivial.
- Rate-limit counters ~50 B × 10⁵ keys = 5 MB.
- BullMQ job state varies; bound per queue.
- Headroom: depends on host RAM allocation (default Redis container has no RAM cap; setting `maxmemory` in compose is recommended at deploy time).

### 2.6 Object storage (MinIO)

- Single node.
- No HA, no replication, no SSE-S3 enabled.
- **Backup story**: the `cmc-backups` bucket in defaults is not actually being written to (no backup cron).

**Capacity ceiling:** disk size of the single MinIO host. For Horizon-1 (10³ users × ~100 MB upload-quota = 100 GB) trivial. For Horizon-3 needs distributed MinIO (4+ node erasure-coded) or external S3.

---

## 3. Realtime tier

**Entire tier absent.** The WS gateway, NATS, Redis pub/sub, presence — none exist.

**Implication for scale:**
- Today the UI has zero realtime surfaces. Page loads → server components → done.
- The dashboard's "+5 24h" delta indicators and the "Cabinet briefed at 03:15" hero are **static prose**, not realtime data.

**When the WS gateway lands (Roadmap P2.3):**
- Per-instance connection budget ~50k (ToR §7.8 capacity model).
- Sticky-session L4 load balancer keyed on user-id-hash or session cookie.
- Cross-instance fanout via Redis pub/sub or NATS internal subjects.
- 100 nodes × 50k = 5M concurrent — far beyond all named horizons.

**For Horizon-3 (10⁵ users with ~30 % concurrently online):** ~3×10⁴ connections — within one WS-gateway node.

---

## 4. GIS tier

**Absent.** When it lands (Roadmap P2.7–P2.9):

- Spatial reads scale via PostGIS GIST + zoom-level-precomputed geometry columns + tile CDN.
- Tile generation P95 ≤ 200 ms cold, ≤ 20 ms warm (ToR §15.4 budget).
- Read replicas for tile generation offload OLTP (ToR §4.17).
- Geofence evaluation: in-memory R-tree, ~10M evaluations/s achievable on a single node (ToR §4.7).

**Risk:** tile cache invalidation is the canonical "hard problem." ToR §4.18 prescribes tag-based event-driven invalidation — depends on the event bus (P2.1) existing.

---

## 5. Search

**Postgres-FTS-via-`ILIKE` today (TD-x).** Full-text via Postgres `tsvector` is the Phase-2 interim; **OpenSearch is the Phase-3 endpoint.**

**Capacity per-tenant:**
- ILIKE wildcard scan: ~10⁴ rows is the practical comfort ceiling on indexed columns.
- `tsvector` + GIN: ~10⁶ rows / tenant on modern hardware.
- OpenSearch: 10⁸+ documents per tenant routine.

---

## 6. Event bus

**Absent.** When NATS JetStream lands (Roadmap P2.1):

- Single-node JetStream sustains ~1M msg/s for our message sizes (ToR §3.6).
- For Horizon-1 traffic (~10⁵ events/day) the cap is comfortable by 4 orders of magnitude.
- For Horizon-3 (10⁹ events/day) NATS Leafnodes / cluster topology + selective replication (ToR §7.6).

---

## 7. Frontend / BFF

### 7.1 Next.js rendering

- All pages are **Server Components** + **Server Actions**. No client-side data fetching for the current surfaces.
- `cache: 'no-store'` set in `apiFetch`. Every request hits the API; no Next.js data-cache or ISR yet.

**Capacity:**
- Each `/dashboard` render = 1 `/auth/me` call. ~10 ms.
- Each `/documents` render = 1 `/documents` list call. ~30–80 ms depending on document count.

**Headroom:** Next.js dev mode is the limiter today, not production builds. In production, Server Components can render at thousands per second per node, dominated by the upstream API.

### 7.2 Caching strategy

**Not configured.** ToR §15.2 calls for L1 (process-local LRU), L2 (Redis), L3 (CDN), L4 (DB materialised views).

For now: no caching is a deliberate choice while data freshness is the priority. As soon as the dashboard renders real ClickHouse-backed metrics, a short-TTL Redis cache between the API and ClickHouse becomes the obvious add.

---

## 8. CI throughput / dev-loop scalability

- CI run cold ~6–9 minutes (build + Postgres image build + integration job).
- Concurrency-cancel prevents minute-budget overruns on iterative PRs.
- Single-OS, single-Node matrix (acceptable per ADR-0005).

**Suggested:**
- GHA cache the Turbo cache → ~2 min savings on warm runs.
- GHA cache the Docker layer for the custom Postgres image → ~30 s savings.
- ADR-0005 §"known gaps" already names these as queued.

---

## 9. Capacity model for Horizon-1 (10³ users, single region)

Assuming:
- 10³ users, ~30 % online during peak hour
- 5 requests per user per minute peak
- 1 % SEV-2-equivalent surge factor

→ 300 users × 5 req/min × 60 = 90 000 req/h = ~25 RPS sustained, ~50 RPS peak.

| Resource | Capacity at current shape | Headroom |
|---|---|---|
| API instance | ~200 RPS (1 inst × 20 conns / 100 ms) | 4× peak |
| Postgres | 200 max conn × ~50 ms per query | 20× peak |
| MinIO single node | thousands of ops/sec | 50× peak |
| Redis (when wired) | ~10⁵ ops/sec | 1000× peak |

**Verdict:** **Horizon-1 fits on the current shape with the P0–P1 additions** (rate-limit, MFA, RBAC, observability, backups). HA is not required; a single instance is acceptable per ADR-0001.

---

## 10. Capacity model for Horizon-2 (10⁴ users, multi-region active-passive)

Assuming the additions in [Roadmap H2](./ROADMAP.md#horizon-2--beta):

| Resource | Required configuration |
|---|---|
| API | 2–3 instances behind sticky LB |
| Postgres | Primary + 1 streaming replica; PgBouncer in front |
| ClickHouse | Single shard with 1 replica |
| NATS | Single-node JetStream; outbox tail-relay |
| WS gateway | 1 instance (sufficient up to ~50k concurrent) |
| MinIO | 4-node distributed; SSE-S3 enabled |
| Redis | Single instance with persistence; cluster optional |

**Largest scaling concern at H2:** the **dashboard ↔ ClickHouse query cost**. Materialised views + projections collapse this; budget P95 ≤ 1.5 s per dashboard (ToR §15.5).

---

## 11. Capacity model for Horizon-3 (10⁵ users, multi-region active-active)

Not a current-conversation. The architectural promise from the ToR (modular monolith → DDD-bounded distributed system without rewrite) is preserved by:

- Module-owned data (no cross-module FKs)
- Event-driven cross-module reactions
- Stateless services
- Tenant-context as a Day-0 primitive

**Open question for H3:** how the **per-tenant DEK / per-tenant audit chain / per-tenant retention** scale when tenants are themselves distributed across regions. ToR §15.9 sketches the answer; implementation deferred to H3.

---

## 12. Identified scaling bottlenecks (today + queued)

| # | Bottleneck | Active? | When it bites | Fix |
|---|---|---|---|---|
| 1 | ~~Session-active lookup on Postgres per auth request~~ | ✅ **resolved by P0.4 / ADR-0011** | Redis-backed cache with TTL = JWT_ACCESS_TTL; DB load on hot path drops orders of magnitude |
| 2 | DB connection pool exhaustion when scaling API instances | Latent | > 8 API instances | P2.x PgBouncer |
| 3 | ILIKE substring scan in documents list | Latent | ~10⁴ docs / tenant | P2.11 tsvector + GIN |
| 4 | No analytical store → dashboard scans OLTP | Active when dashboard goes real | H2 entry | P2.5 ClickHouse |
| 5 | Audit row growth on single Postgres table | Latent | ~10⁷ rows | P2.2 archive to ClickHouse, BRIN + partition |
| 6 | No cache for any read | Active (no cache exists) | Whenever the platform hits production read traffic | P0.4 + ongoing |
| 7 | Single MinIO node | Latent | TB-scale uploads | H3 distributed MinIO |
| 8 | No WS scaling pattern | Latent | When realtime lands | P2.3 design includes Redis pub/sub from day one |
| 9 | `refreshInFlight` Map per web process | Active when scaling web > 1 instance | First web HPA | Move to Redis (P0.4-adjacent) |
| 10 | Transaction interceptor holds conn for full request | Active | Long-running handlers | Acceptable today; refactor handlers that do > 100 ms before DB-ops |

---

## 13. Multi-region considerations

**Today:** N/A (single region).

**When H2 multi-region active-passive lands:**
- Logical replication for selective tables (skip ephemeral `sessions`; replicate `users`, `documents` metadata, `audit_log`, `tenants`).
- Asynchronous; RPO ≤ 5 min for Tier-1.
- MinIO bidirectional bucket replication.
- The Auth.js session cookie is region-independent (JWT-based session strategy). Refresh would be region-pinned (the session row lives in the primary).

**When H3 active-active lands:**
- Identity service goes globally-readable (eventually consistent).
- Tenant data primary-region pinned; cross-region read replicas for collaboration with users abroad.
- Selective event replication (NATS Leafnodes).

---

## 14. Load-testing strategy (not yet in place)

ToR §15.10 requires quarterly load tests with k6 / Gatling and periodic chaos engineering (Chaos Mesh / Litmus). **None of this exists today.**

**Recommended Day-1 load test (P1 exit gate):**
- k6 scenario: ramp from 0 → 100 concurrent users → 100 RPS sustained for 10 min → ramp down.
- Targets: `/v1/auth/login`, `/v1/auth/me`, `/v1/documents` list, `/v1/documents/upload-init` + presigned PUT + `/v1/documents/:id/finalize`.
- Pass criteria: P95 < 500 ms on read endpoints, P95 < 1 s on writes, error rate < 0.1 %.

**Chaos drill (P2 exit gate):**
- Kill primary Postgres → expect P0.5 backup-based recovery within RTO.
- Kill MinIO → expect uploads to error gracefully; downloads of cached objects still work.

---

## 15. Synthesis

The codebase is **right-sized for its current scale (single tenant, internal users)** and **architected to grow without rewrite**. The biggest scalability bets that have been **made well**:

1. **Modular monolith** (ADR-0001) — postpones the distributed-systems tax until justified.
2. **Tenant-context-by-construction** — never need to retrofit multi-tenancy.
3. **Outbox-shaped audit log** — the table already has the columns needed for tamper-evidence + projection.
4. **Pre-signed direct-to-S3 upload** — the API never proxies bytes.

The biggest scalability bets that **have not been made yet** but **must be made on schedule**:

5. **Event plane** (NATS + outbox) — gates every cross-module reaction.
6. **Analytical plane** (ClickHouse) — gates real dashboards.
7. **Realtime plane** (WS gateway + Redis pub/sub) — gates collab + live monitoring.
8. **HA at the OLTP tier** (replicas + PgBouncer + Patroni) — gates production credibility.

A platform that makes all eight on schedule reaches Horizon-3 without an architectural rewrite. A platform that **skips any one of them** rebuilds later at significantly higher cost. The ADR record so far suggests the team is making the right calls on what to defer and what to address; this review is in agreement with that posture.
