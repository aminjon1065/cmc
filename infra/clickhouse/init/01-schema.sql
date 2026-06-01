-- ClickHouse analytical schema (P2.5 / ADR-0033).
-- Runs once on first container start (/docker-entrypoint-initdb.d). The Node
-- projection consumer (P2.5b) inserts incident events into `incident_events`;
-- the materialised view rolls them up into daily-by-region stats incrementally.

CREATE DATABASE IF NOT EXISTS cmc;

-- Raw incident event stream (one row per projected event).
CREATE TABLE IF NOT EXISTS cmc.incident_events
(
  event_id    UUID,
  tenant_id   UUID,
  incident_id UUID,
  event_type  LowCardinality(String),
  severity    UInt8,
  region      String,
  type        String,
  status      LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (tenant_id, occurred_at);

-- Target table for the daily-by-region rollup (incrementally summed).
CREATE TABLE IF NOT EXISTS cmc.incident_daily_stats_by_region
(
  tenant_id UUID,
  day       Date,
  region    String,
  incidents UInt64
)
ENGINE = SummingMergeTree
ORDER BY (tenant_id, day, region);

-- MV: every `created` event increments the (tenant, day, region) bucket.
CREATE MATERIALIZED VIEW IF NOT EXISTS cmc.incident_daily_stats_mv
TO cmc.incident_daily_stats_by_region AS
SELECT
  tenant_id,
  toDate(occurred_at) AS day,
  region,
  count() AS incidents
FROM cmc.incident_events
WHERE event_type = 'created'
GROUP BY tenant_id, day, region;
