# ADR-0033: ClickHouse analytics + incident projection consumer

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P2.5
**Depends on:** ADR-0031 (event plane), ADR-0032 (consumer pattern), ADR-0023 (incidents)
**Unblocks:** P2.2 (audit projection), P2.6 (dashboard real data)

## Context

OLTP Postgres is the wrong engine for analytical queries (counts/rollups over
large event histories) and for long-term retention. ToR §5 calls for a columnar
analytical store. With the event plane (P2.1) emitting incident events, P2.5
stands up **ClickHouse** and the **second durable consumer** — a projection that
feeds an incrementally-maintained daily rollup.

## Decision

A single-shard ClickHouse, fed by a Node projection consumer that reuses the
P2.4 pattern; a materialised view does the aggregation in the database.

### Schema — raw stream + MV

- **`cmc.incident_events`** (`MergeTree`, ordered by `(tenant_id, occurred_at)`):
  one row per projected incident event — the raw analytical stream.
- **`cmc.incident_daily_stats_by_region`** (`SummingMergeTree`): the daily
  rollup target.
- **`incident_daily_stats_mv`** (materialised view): every `created` event
  increments the `(tenant_id, day, region)` bucket. The MV aggregates **in
  ClickHouse** — the consumer just inserts raw rows; CH maintains the rollup
  incrementally. Schema applied from a mounted init SQL on first container start.

### Node projection consumer, not CH-native NATS

A `IncidentProjectionConsumer.handle()` (pure, idempotent) inserts incident
events into `incident_events`; a durable subscriber drives it. Chosen over CH's
native NATS table engine so the projection logic is **testable** (the CH client
is a faked seam — `@clickhouse/client` dynamic-imported only when
`CLICKHOUSE_ENABLED`, never in jest) and decoupled from CH's ingestion specifics.
Reuses the exact P2.4 consumer/subscriber/dedup pattern.

### `DeliverPolicy.All` — projections backfill

Unlike the notifications consumer (`New`), the projection uses **`All`**: a fresh
projection *wants* to replay the whole stream and backfill ClickHouse. The
`consumed_events` dedup ledger (keyed by `(event_id, "incident-projection")`)
makes the backfill idempotent — each event inserted once even across replays.

### Bucket by occurrence time

The projected `occurred_at` prefers the incident's **real-world occurrence time**
(in the `created` payload) over the event-emission time, so the daily-by-region
stats bucket by when the incident happened, not when it was recorded.

### Gating

`CLICKHOUSE_ENABLED` gates the client + the projection (off by default — dev/test
boot without CH); the subscriber additionally needs `NATS_ENABLED`. HTTP port
8123 only (native 9000 collides with MinIO; `@clickhouse/client` uses HTTP).

## Consequences

**Positive**
- Analytical store online; incident events project into it via the proven
  consumer pattern — verified live (HTTP create → relay → NATS → projection → CH
  row → MV rollup `(2026-…, Sughd, 1)`).
- MV does the aggregation in-database (cheap incremental rollups; no app-side
  recompute).
- The CH client + projection consumer are the template P2.2 (audit projection)
  reuses; **P2.2 and P2.6 are now unblocked**.
- Zero footprint when disabled (noop client; subscriber idle); jest never loads
  the driver.

**Negative / deferred**
- **`transitioned` rows carry sparse columns** (no region/severity — not in the
  payload); the MV only consumes `created`, so stats are unaffected. Enriching
  the raw stream (cross-store lookup) is deferred.
- **Single shard, no replication** — H-tier concern.
- **No CH schema migration tooling** yet (raw init SQL); changes need manual
  `ALTER`. A CH migration story is deferred.
- **`incident_events` / `consumed_events` retention** — pruning deferred.
- Same single-instance / dead-letter caveats as ADR-0032.

## Validation

- **Suite**: 219/219, 28 suites. `incident-projection` (3): `created` projected
  (right columns, **occurrence-time bucketing**) + idempotent; `transitioned`
  projected with new status; unhandled events ignored (no insert, no claim) —
  all via a faked CH client.
- **Live smoke** (real CH + NATS): `POST /v1/incidents` → relay → NATS →
  projection consumer → `cmc.incident_events` row (`created, Sughd, 4, reported`)
  → `incident_daily_stats_by_region` MV → `(2026-06-01, Sughd, 1)`.
- **Infra**: ClickHouse container healthy; schema (2 tables + MV) applied from
  init SQL.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean.
