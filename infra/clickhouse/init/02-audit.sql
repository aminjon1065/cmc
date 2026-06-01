-- ClickHouse audit projection schema (P2.2 / ADR-0034).
-- The audit log is a firehose (every action), so it's projected by a cursor
-- ETL (not the event bus): the Node AuditProjectionService tail-reads
-- `audit_log` by `seq` and inserts here. Long-term retention + analytics off
-- the OLTP path. Delivery is at-least-once (the cursor makes duplicates rare —
-- a crash window only); analytics tolerate it.

CREATE TABLE IF NOT EXISTS cmc.audit_events
(
  id            UUID,
  seq           UInt64,
  tenant_id     Nullable(UUID),
  actor_id      Nullable(UUID),
  actor_type    LowCardinality(String),
  action        LowCardinality(String),
  resource_type LowCardinality(String),
  resource_id   String,
  outcome       LowCardinality(String),
  ip            Nullable(String),
  request_id    Nullable(String),
  trace_id      Nullable(String),
  occurred_at   DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (occurred_at, seq);

-- Daily counts by action + outcome (the audit observatory rollup).
CREATE TABLE IF NOT EXISTS cmc.audit_daily_stats
(
  day     Date,
  action  LowCardinality(String),
  outcome LowCardinality(String),
  events  UInt64
)
ENGINE = SummingMergeTree
ORDER BY (day, action, outcome);

CREATE MATERIALIZED VIEW IF NOT EXISTS cmc.audit_daily_stats_mv
TO cmc.audit_daily_stats AS
SELECT
  toDate(occurred_at) AS day,
  action,
  outcome,
  count() AS events
FROM cmc.audit_events
GROUP BY day, action, outcome;
