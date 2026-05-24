# OBSERVABILITY REVIEW
## Logs · Metrics · Traces · Alerting · Audit-monitoring · Health probes · SLOs

**Audit date:** 2026-05-24
**Reference:** ToR §13.10–§13.12, §14, §20.1 principle 7 ("Untraced is unfinished")
**Verdict:** **critical gap.** The platform has audit logging from day one (a notable strength), but **none of the other observability pillars exist**. This is the single highest-impact deferral in the codebase: every other gap can be patched while running; observability cannot be added under fire.

---

## 1. The four signals — state of each

| Signal | Spec (ToR §14) | Current state | Severity |
|---|---|---|---|
| **Metrics** | Prometheus + Thanos · RED + USE per service · per-tenant breakdown | None — no `/metrics` endpoint, no Prometheus client library imported | S0 |
| **Logs** | Structured JSON · Loki aggregation · `trace_id` correlated · PII redacted | ✅ Structured JSON (pino) + request_id correlation + PII redact (P0.3 / ADR-0010); aggregation (Loki) deferred to P1.7 | 🟡 partial |
| **Traces** | OpenTelemetry · Tempo/Jaeger backend · W3C Trace Context propagation · head + tail sampling | None — no SDK, no exporter; the ALS request-context slot is reserved for trace_id at P0.6 | S0 |
| **Audit** | Append-only · tamper-evident chain · WORM · SIEM-exportable | Append-only ✅ · chain ❌ · WORM convention only · SIEM export ❌ · **request_id ✅ populated post-P0.3** | S1 |

The codebase has **two of four pillars partially in place** (audit, logs) and **two of four entirely missing** (metrics, traces).

---

## 2. Logging audit — ✅ landed 2026-05-25 (P0.3 / ADR-0010)

### 2.1 What exists post-P0.3

- `nestjs-pino` is the platform logger. All 13 `new Logger(...)` call sites pipe through pino transparently.
- Output: JSON in production; pino-pretty (human-readable) in non-prod.
- `RequestContextService` (ALS) + `RequestContextMiddleware` mint / validate UUID v4 `X-Request-Id`; honor inbound when UUID-shaped, reject otherwise.
- pino mixin reads both `RequestContextService` and `TenantContextService` at log time → every line carries `requestId`, optionally `tenantId`, `tenantSlug`, `userId`.
- `AuditService.toRow()` auto-populates `request_id` from ALS — every audit row is correlatable with its log lines.
- PII redaction via pino `redact` paths: `authorization`, `cookie`, `x-api-key`, `password`, `refreshToken` (plus defensive `*.password` / `passwordHash`).
- Custom `req` serializer trims headers to a safe allowlist — Authorization / Cookie cannot leak even via raw `req` dumps.
- CORS exposes `X-Request-Id` so the web app surfaces it in error UIs.
- `bufferLogs: true` ensures Nest's bootstrap logs flow through pino, no format-skew at process start.

### 2.2 What's still missing

- **`trace_id` / `span_id`** — the ALS slot is reserved; OTEL plumbing lands at P0.6.
- **Log aggregation.** No Loki / OpenSearch / Vector / Fluent Bit shipper yet → P1.7.
- **Retention / rotation.** Docker handles size capping; explicit policy lands at P0.9 (deploy concern).

### 2.3 Remediation status

| Action | Effort | Status |
|---|---|---|
| Switch to `nestjs-pino` | XS | ✅ P0.3 |
| Middleware sets `req.requestId = randomUUID()`; attach to pino context | XS | ✅ P0.3 |
| Populate `request_id` on audit log writes | XS | ✅ P0.3 |
| Redaction list (email-typed properties, password fields, tokens) | S | ✅ P0.3 (email visible per ADR-0010) |
| Loki + Promtail (or Grafana Agent) in `infra/observability-compose.yml` | S | 🔴 P1.7 |
| Retention via Loki's `compactor` and S3-backend cold tier | M | 🔴 H3 |

---

## 3. Metrics audit

### 3.1 What exists

**Nothing.** No `prom-client`, no OTEL exporter, no `/metrics` endpoint.

The only signal a Prometheus would see today is whatever Caddy / a future reverse-proxy emits at the edge — and Caddy isn't even configured yet.

### 3.2 What's needed (ToR §14.1 + §14.3)

**RED per service per route:**
- `http_requests_total{method, route, status}` — counter
- `http_request_duration_seconds{method, route}` — histogram (P50/P95/P99 derivable)
- `http_errors_total{method, route, code}` — counter

**USE per resource:**
- DB pool: `db_connections_in_use`, `db_connections_idle`, `db_query_duration_seconds`
- Postgres queries: `db_queries_total{query_kind}`, `db_query_errors_total`
- Redis: `redis_ops_total`, `redis_op_duration_seconds` (when Redis is wired)
- S3 ops: `s3_ops_total{op}`, `s3_op_duration_seconds`

**Business metrics:**
- `active_sessions_total{tenant_id}` (low-cardinality enough for tens of tenants; protect with `__name__` allow rule at scale)
- `documents_total{tenant_id, status}`
- `audit_events_total{tenant_id, action, outcome}`
- `login_attempts_total{outcome}`

### 3.3 Cardinality hazards

ToR §14.1 specifically warns about high-cardinality labels. At H2+ with hundreds of tenants, `tenant_id` as a label exceeds Prometheus's comfort zone. Two mitigations: (a) Thanos / Mimir with sharded TSDB; (b) per-tenant counters reported via OpenTelemetry which can route per-tenant streams differently. Acceptable for H1 (≤10 tenants).

### 3.4 Remediation

| Action | Effort | Roadmap |
|---|---|---|
| OTEL SDK + Prometheus exporter + `/metrics` endpoint | S | P0.7 |
| First Grafana dashboard (RED per route) checked into `infra/observability/dashboards/` | S | P0.7 |
| DB-pool metric instrumentation in `database.module.ts` | XS | P0.7 |
| Business metrics (sessions, documents, audit) | S | P1.x |
| `tenant_id` cardinality decision | — | P1 review |

---

## 4. Tracing audit

### 4.1 What exists

**Nothing.** No OpenTelemetry SDK, no exporter, no W3C Trace Context propagation, no header parsing.

### 4.2 What's needed

- `@opentelemetry/sdk-node` + auto-instrumentations for HTTP, Postgres (`pg`/`postgres`), AWS SDK, NestJS.
- Exporter to a single-instance Tempo container.
- W3C `traceparent` header propagation in `apiFetch` and `authedApiFetch` so traces span the BFF → API hop.
- `trace_id` attached to every audit-log row and every log line.
- Head-based sampling (10 % baseline per ToR §13.11) + tail sampler (always-keep errors + slow > P95).

### 4.3 The high-value early trace

The most useful first trace is **login**:
- Browser → Next.js Server Action → API `/auth/login` → `runPrivileged` tx → users lookup → argon2 verify → session insert → audit insert → token sign → response.
- A single trace per login tells you which step blew the latency budget; today a slow login is debugged by reading code.

### 4.4 Remediation

| Action | Effort | Roadmap |
|---|---|---|
| OTEL SDK initialisation in `main.ts` | XS | P0.6 |
| Auto-instrumentations | XS | P0.6 |
| Tempo container in `infra/observability-compose.yml` | XS | P0.6 |
| Propagate `traceparent` from Server Components in `authedApiFetch` | S | P0.6 |
| Tail-based sampler (errors + slow) | S | P1.x |
| Trace-id on audit-log rows | S | P0.6 |

---

## 5. Health probes audit

### 5.1 What exists — `apps/api/src/modules/health/health.controller.ts`

```
GET /health → 200 { status: "ok", version, uptimeSeconds, timestamp }
```

This is **liveness only.** It does not probe Postgres, Redis (when wired), or MinIO. A Kubernetes / Caddy load balancer using this for readiness would route traffic to a dead API instance whose DB is unreachable.

### 5.2 What's needed (ToR §14.8)

| Probe | Endpoint | Behaviour |
|---|---|---|
| Liveness | `GET /health` (today) | "process is alive" — never checks deps |
| Readiness | `GET /health/ready` | "ready to serve" — pings DB / Redis / MinIO and returns the conjunction |
| Startup | `GET /health/startup` | for slow boots — passes once initial migrations + config validation complete |
| Deep | `GET /health/deep` (admin-only) | full per-dependency status + timings; suitable for runbook diagnostics |

**Synthetic monitoring:** a 5-minute curl-loop of the login flow from an external host. The simplest CI-driven option for now; a proper synthetic monitor (k6 / GitHub Actions cron) at H1 exit.

### 5.3 Remediation

| Action | Effort | Roadmap |
|---|---|---|
| Implement `/health/ready` | XS | P0.8 |
| Implement `/health/deep` (admin-only) | S | P0.8 |
| External synthetic probe (GHA cron hits `/health/ready` from a different region) | XS | H1 |

---

## 6. Alerting audit

### 6.1 What exists

**Nothing.** No Alertmanager, no rules, no notification routing. Failures today are visible only if a developer is watching `docker logs`.

### 6.2 What's needed (ToR §14.4)

- Alertmanager wired to Prometheus (P0.7) with one starter rule (`5xx ratio > 1 % over 5 min`).
- Webhook routing to a dev channel until the in-platform Notification System (P1.6) exists.
- Severity ladder: SEV1 (page immediately), SEV2 (page during business hours), SEV3 (ticket), SEV4 (informational).
- **Every alert must have a runbook link.** ToR §14.4 hygiene rule.
- Alert grouping + inhibition rules to prevent storm.
- Self-hosted on-call scheduler (Grafana OnCall, open-source).

### 6.3 Day-1 alert set (recommended)

| Alert | Trigger | Severity |
|---|---|---|
| API 5xx ratio > 1 % / 5 min | Prometheus | SEV2 |
| API P95 latency > 1 s / 5 min on auth routes | Prometheus | SEV2 |
| DB connections > 80 % of pool / 5 min | Prometheus | SEV3 |
| Audit-log write failures > 0 / 5 min | Custom counter | SEV2 |
| Refresh-token replay events (`rotation_replay`) > 5 / hour | Custom counter | SEV2 (suspicious activity) |
| Health-ready failures > 2 in 5 min | Synthetic probe | SEV1 |
| Disk free < 20 % (Postgres / MinIO hosts) | node_exporter | SEV2 |

### 6.4 Remediation roadmap

P1.8 — Alertmanager with the first 3 rules. Subsequent rules added per-module as modules land.

---

## 7. Audit monitoring (ToR §14.5)

The audit log itself is the strongest signal source the platform has today, but **nothing watches it.** No detection rules for:
- Mass deletion (one user deleting many documents in a short window)
- Privilege escalation (role changes — when RBAC lands)
- Off-hours admin actions
- Repeated `rotation_replay` for the same user (active credential theft)
- Login failures clustered on a single email or IP (online brute-force)

Two implementation paths:
1. **SIEM-side detection** — forward audit-log via Syslog/CEF to a Wazuh / OpenSearch Security Analytics instance, define rules there.
2. **Application-side detection** — a worker that polls audit-log windowed-by-rule and emits alerts to the notification system.

Path (1) matches ToR §14.6 ("Internal SIEM stack: Wazuh or OpenSearch Security Analytics"). Path (2) is cheaper as a starter — one cron-like NestJS worker per rule.

---

## 8. SIEM integration audit

ToR §14.6 calls for:
- Wazuh / OpenSearch Security Analytics as the default internal SIEM.
- Vector / Fluent Bit as the forwarder.
- Syslog RFC 5424 + CEF as the export format.
- Optional outbound integration for tenants that operate their own commercial SIEM.

**State today:** **nothing.** No forwarder, no destination, no format converter.

**Remediation (P1.12):** a small NestJS worker that tail-reads `audit_log` (LISTEN/NOTIFY or polling cursor) and writes to a file/stream in RFC 5424 + CEF. Even without a SIEM running, this fixes the "format is the contract" property — the platform's export shape is locked.

---

## 9. Operational dashboards audit (ToR §14.7)

No Grafana. No dashboards. The pieces that would live there:

| Dashboard | Audience | Contents |
|---|---|---|
| **Platform health** | SRE | All services, all deps, color-coded |
| **Tenant SLO compliance** | Tenant admin + SRE | Per-tenant SLO bands |
| **Auth observatory** | Security + SRE | login attempts, failures by reason, MFA enrollment ratio (when MFA lands) |
| **Documents observatory** | Product | Uploads / sec, finalize success ratio, average size, failed status root-cause |
| **Audit feed** | Security | Recent denies, suspicious patterns |

**Remediation:** check dashboards-as-code into `infra/observability/dashboards/*.json`. Grafana provisioner picks them up.

---

## 10. SLO / SLA / error-budget audit

**Not defined.** No documented SLOs exist for any endpoint.

**Recommended starter SLOs (post-H1):**

| SLI | SLO | Window |
|---|---|---|
| Auth login P95 latency | < 500 ms | 7-day rolling |
| Auth login availability | > 99.9 % | 30-day |
| Documents list P95 | < 800 ms | 7-day |
| Documents upload-init availability | > 99.95 % | 7-day |
| Audit-log durability (no missing IDs) | > 99.99 % | 30-day |

Error-budget remaining displayed on the SRE dashboard. Budget exhaustion → feature-freeze trigger.

---

## 11. Cost-of-observability check

The whole observability stack (Prometheus + Loki + Tempo + Grafana + Promtail) fits in **~512 MB RAM + ~10 GB disk for 30 days of logs/metrics/traces** at this scale. **Not a budget concern.** The cost is **operational attention**, not infrastructure.

---

## 12. The audit log as foundation

A real strength of the codebase: **the audit log is good enough today to be the foundation of observability** *because the columns and discipline are right*. With:
- `request_id` populated (P0.3)
- `trace_id` populated (P0.6)
- Hash chain populated (P1.11)
- Streaming export (P1.12)
- ClickHouse archive (P2.2)

…the audit log becomes the central security event store + the source-of-truth for "what happened" diagnostics. This is **load-bearing for compliance** (SOC 2, ISO 27001) and for **incident forensics**. Treat it as such.

---

## 13. Severity-ordered findings

### S0 — must address before any non-dev deployment

1. **No structured logs.** Adopt pino; populate `request_id` (P0.3).
2. **No `/metrics` endpoint.** Add OTEL Prometheus exporter (P0.7).
3. **No traces.** Add OTEL SDK + Tempo (P0.6).
4. **No deep health probe.** Add `/health/ready` (P0.8).
5. **No alerting.** Add Alertmanager + 3 starter rules (P1.8).

### S1 — high

6. **No log aggregation.** Loki container (P1.7).
7. **No trace_id correlation in audit log.** Fix as part of P0.6.
8. **No SIEM export.** P1.12.
9. **No SLO definitions.** Document starter SLOs at H1 exit.
10. **No audit-pattern detection.** First three rules at H1 exit.

### S2 — medium

11. **No synthetic monitoring.** GHA cron probe at H1 exit.
12. **No per-tenant dashboard.** H2.
13. **No on-call scheduler.** H2 (Grafana OnCall self-hosted).
14. **No chaos drills.** H3.

---

## 14. Recommended Day-1 observability stack (compose addendum)

```yaml
# infra/observability-compose.yml

services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.96.0
    ports: ["4317:4317", "4318:4318"]
    volumes: ["./observability/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro"]

  prometheus:
    image: prom/prometheus:v2.51.0
    ports: ["9090:9090"]
    volumes:
      - "./observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro"
      - "prometheus_data:/prometheus"

  loki:
    image: grafana/loki:2.9.4
    ports: ["3100:3100"]
    volumes: ["loki_data:/loki"]

  promtail:
    image: grafana/promtail:2.9.4
    volumes:
      - "/var/lib/docker/containers:/var/lib/docker/containers:ro"
      - "./observability/promtail.yml:/etc/promtail/config.yml:ro"

  tempo:
    image: grafana/tempo:2.4.1
    ports: ["3200:3200", "4317:4317"]
    volumes: ["./observability/tempo.yml:/etc/tempo.yml:ro"]

  grafana:
    image: grafana/grafana-oss:10.4.1
    ports: ["3001:3000"]
    volumes:
      - "./observability/dashboards:/etc/grafana/provisioning/dashboards:ro"
      - "./observability/datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro"
      - "grafana_data:/var/lib/grafana"

  alertmanager:
    image: prom/alertmanager:v0.27.0
    ports: ["9093:9093"]
    volumes: ["./observability/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro"]

volumes:
  prometheus_data:
  loki_data:
  grafana_data:
```

Total: 6 services + 3 volumes. ~500 MB RAM. **Adds a `pnpm infra:obs:up` script** to bring the stack up alongside the existing infra.

---

## 15. Closing observation

**Of all the gaps in this audit, observability is the cheapest to close.** The hard work — choosing self-hosted, open-source, well-supported tools — is done by ToR §14. The only barrier is the engineer-hours.

The single highest-leverage action in the entire backlog: **stand up the observability stack before the second domain module lands.** Every line of code that follows is then debuggable, profilable, and operable. Every line of code that precedes it is invisible.

ToR §20.1 principle 7 is right: "untraced is unfinished." Today every module is unfinished by that standard, including the well-built ones.
