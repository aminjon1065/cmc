# ADR-0030: SIEM-ready audit export (RFC 5424 syslog + CEF)

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.12
**Depends on:** ADR-0010 (audit log), ADR-0029 (tamper-evident chain — `seq`)
**ToR:** §6.15 (SIEM export — Syslog RFC 5424 + CEF)

## Context

ToR §6.15 wants the audit log exportable to a SIEM in **Syslog RFC 5424** and
**CEF**. The point — even before a SIEM is deployed — is that *the format is the
contract*: lock the export shape now so the platform's audit stream is
SIEM-ingestible from day one, and so the on-disk/on-wire representation doesn't
churn once a Wazuh / OpenSearch / Splunk lands.

## Decision

A polling **export worker** tail-reads the (now tamper-evident) audit log by
`seq` cursor and ships each row through a pluggable sink.

### Cursor, not LISTEN/NOTIFY

The worker keeps a durable cursor (`audit_export_cursor`, single row,
`last_seq`) and polls `WHERE seq > cursor ORDER BY seq LIMIT batch`. `seq` is
the monotonic column from P1.11a, so ordering is exact and gap-free. Polling
(over LISTEN/NOTIFY) is simpler, restart-safe, and naturally batches — fine for
the audit volume at this scale. The cursor is in the DB (not Redis) so a cache
flush can't reset it and trigger a full re-export.

### `flush()` always runs; `enabled` only gates the timer

`flush()` is the unit of work and runs whenever called — the background interval
(`AUDIT_EXPORT_INTERVAL_SEC`), the `POST /v1/audit/export/flush` endpoint, or a
test. `AUDIT_EXPORT_ENABLED` gates **only** the background timer. This decouples
the feature's logic from the on/off switch, makes it trivially testable, and
lets an operator force a flush regardless of the schedule.

### At-least-once delivery

The cursor advances only **after** the sink write succeeds *and* the transaction
commits (the write is a side effect inside the privileged tx; if it throws, the
tx rolls back and the cursor stays put). So a crash mid-batch re-ships — the SIEM
dedups on the audit row `id` (the stable event id in both formats). Never drops,
may duplicate. A blocking advisory lock serialises exporters cluster-wide.

### Formats (both implemented, one per destination)

- **RFC 5424**: `<PRI>1 TS HOST cmc-audit - MSGID [cmc@99999 …] MSG`. PRI =
  facility 13 (*log audit*) × 8 + severity (success→info 6, denied→notice 5,
  failure→warning 4). Fields ride in structured data (`eid`, `seq`, `tenant`,
  `actor`, `outcome`, `src`, `requestId`, `traceId`, …), escaped per §6.3.3.
- **CEF**: `CEF:0|CMC|Platform|1.0|<action>|<action>|<sev>|<ext>` with standard
  keys (`suid`, `suser`, `act`, `outcome`, `src`, `rt`, `deviceExternalId`) +
  custom `cs1`=traceId, `cs2`=tenantId, `cn1`=seq. Header/extension escaped.

Picked by `AUDIT_EXPORT_FORMAT`; the audit row `id` is the dedup key in both.

### Pluggable sink

`AuditExportSink` (token `AUDIT_EXPORT_SINK`, chosen by a config factory):
`noop` (default — format-but-discard, so nothing leaks until configured),
`stdout`, `file` (append), `tcp` (syslog over TCP, RFC 6587 octet-counting). The
sink is the seam the e2e overrides with a capturing fake — the worker is tested
without touching the filesystem/network (the aws-sdk-style jest hazard), and the
real `file` sink is proven in the live smoke.

### Gating

`GET /v1/audit/export/status` (cursor, pending, format, transport) +
`POST /v1/audit/export/flush`, both `tenant:manage`. The export is a platform
concern (all tenants); a dedicated platform-superadmin gate is a later
refinement (no such role yet).

## Consequences

**Positive**
- ToR §6.15 export shape locked — the (tamper-evident) audit log is
  SIEM-ingestible now, no format churn later.
- At-least-once + durable cursor → no gaps; SIEM dedups duplicates.
- `noop` default means zero emission until an operator opts in.
- Sink abstraction keeps file/TCP/stdout/SIEM-webhook swappable.

**Negative / deferred**
- **Polling latency** — export lags by up to one interval; fine for audit, and a
  manual flush is always available.
- **TCP sink** opens a connection per batch (no pooling/retry queue) — adequate
  at this scale; a persistent forwarder (Vector / Fluent Bit) is the H-tier path.
- No **TLS** on the TCP sink yet; a real SIEM link should run over TLS / a local
  forwarder.
- Reuses `tenant:manage`; a platform-superadmin / `audit:read` gate is cleaner.

## Validation

- **Suite**: 197/197, 23 suites. `audit-export` (9): RFC 5424 + CEF output +
  severity mapping + escaping (pure); flush ships + advances cursor; re-flush is
  a no-op; incremental export; status counts; gated endpoints (401/403/200).
- **Live smoke** (dev DB, `file` sink): `POST /flush` exported **149** rows →
  149 valid RFC 5424 lines on disk (`<110>1 … cmc-audit - user.login [cmc@99999
  …] …`), cursor advanced 0 → 149; status reflected `pending`/`cursorSeq`.
- **Build/lint**: API `tsc` + `nest build` clean.
