# SOC 2 Evidence Register (P3.14)

**Status:** Starter · 2026-06-03 · pairs with [`soc2-control-mapping.md`](./soc2-control-mapping.md)

For a SOC 2 **Type II** an auditor samples evidence *across the audit period*, so
each item needs an owner and a cadence (point-in-time screenshots aren't enough —
recurring artifacts are). This register lists the evidence the platform can
already produce, where it comes from, and what's still missing. Populate the
"Last collected / location" column as you gather artifacts into the audit folder.

## Legend
- **Cadence**: Continuous (system-produced) · Per-change · Daily · Quarterly · Annual · On-event
- **Type**: Automated (system) · Manual (screenshot/export/attestation)

## A. System-produced (automated) evidence — already available

| Control (TSC) | Evidence artifact | Source / how to collect | Cadence | Owner | Last collected / location |
|---|---|---|---|---|---|
| CC6.1 access | Audit log entries (actor, action, resource, outcome, ts) | `GET /v1/audit/...` / DB `audit_log`; SIEM export (ADR-0030) | Continuous | Eng | |
| CC4/CC7 monitoring | Audit chain **verify** result (no tampering) | `GET /v1/audit/chain/verify` (ADR-0029) | Daily | Eng | |
| CC4 monitoring | Merkle **anchor** records under Object Lock (WORM) | `audit_chain_anchor` + MinIO lock bucket (ADR-0029) | Daily/anchor | Eng | |
| CC7.2 detection | Alert history (5xx, stale-backup) | Alertmanager / Grafana (ADR-0026) | Continuous | Eng | |
| CC4.1 monitoring | Metrics dashboards (latency, error rate, pool) | Grafana / Prometheus (ADR-0014) | Continuous | Eng | |
| A1.2 availability | Backup success + restore-drill log | `postgres-backup` cron + `pnpm db:restore` drill (ADR-0012) | Daily / Quarterly | Eng | |
| CC8.1 change mgmt | CI run results (lint, typecheck, 53-suite e2e) | CI pipeline (ADR-0005/0006/0007) | Per-change | Eng | |
| CC8.1 change mgmt | Change records w/ rationale + consequences | `docs/adr/*` + git history | Per-change | Eng | |
| CC6.3 least-priv | Effective access per user (roles + permissions) | `GET /v1/rbac/me`; roles/permissions tables | Quarterly (access review) | Eng | |
| CC6.1 MFA | MFA enrollment state per user | `mfa` table / admin view (ADR-0020) | Quarterly | Eng | |
| CC6.6 boundary | Edge TLS config + security headers | `infra/caddy/Caddyfile`; `caddy validate` (ADR-0016) | Per-change | Eng | |
| A1/CC9 HA | HA topology + scale/failover procedure | `docs/runbooks/ha.md`, `infra/ha/` (ADR-0058) | Annual review | Eng | |
| C1.2/CC6.5 disposal | Retention sweep + legal-hold audit rows | `document.retention_sweep` audit entries (ADR-0050) | Daily | Eng | |

## B. Manual evidence to produce — gaps (collect into the audit folder)

| Control (TSC) | Evidence needed | Status |
|---|---|---|
| CC1.x governance | Code of conduct, org chart, role descriptions (signed) | 🔴 To create |
| CC3.x risk | Risk register + annual risk-assessment minutes | 🔴 To create |
| CC1.4 / HR | Onboarding/offboarding checklists, background checks, security-training records | 🔴 To create |
| CC5.3 policies | Security policy set (access, change, IR, BCP/DR, crypto, data-classification, vendor) | 🔴 To create |
| CC9.2 vendor | Vendor/sub-processor inventory + their SOC 2 reports (cloud host, MinIO/S3, etc.) | 🔴 To collect |
| CC7.4 IR | Security incident-response plan + (if any) incident post-mortems | 🔴 To create |
| CC6.4 physical | Hosting provider's SOC 2 / physical-security attestation | 🔴 To collect |
| CC7.1 vuln mgmt | SAST/dependency/container scan reports + remediation SLAs | 🟡 Dependabot only; add CodeQL/Trivy/ZAP |
| CC6.7 / C1.1 crypto | Encryption-at-rest attestation (DB/object SSE) + key-management record | 🟡 Deploy-dependent; enforce + document |
| CC8.1 change | Staging-environment sign-off + release/rollback log | 🔴 No staging yet |
| A1.3 availability | Scheduled DR test results (beyond the backup restore drill) | 🟡 Backup drill only |

## C. Next steps

1. Stand up an **audit folder** (access-controlled) and start filling column 6 of
   table A from the system sources (most are one command / one query away).
2. Assign **control owners** (eng vs management) per row.
3. Management to open the 🔴 organizational items (policies, risk register, vendor
   list, HR security) — these gate a real audit regardless of product maturity.
4. Close the prioritized **technical** gaps from `soc2-control-mapping.md §Gap
   summary` (scanning in CI, at-rest enforcement, staging, SIEM, DR test).
5. Pick a **Type I** target date once policies + the top technical gaps are in
   place; then run a **Type II** observation window (typically 3–12 months).
