# SOC 2 Control Mapping & Gap Analysis (P3.14)

**Status:** Living document · first cut 2026-06-03
**Owner:** Engineering (technical controls) + Management (governance controls)

## Purpose & scope

This maps the CMC platform's **implemented technical controls** to the AICPA
**Trust Services Criteria (TSC, 2017 / rev. 2022)** so we can (a) see how far the
*product* already supports a SOC 2 examination and (b) enumerate the gaps —
technical and organizational — that must close before a Type I (point-in-time)
and then Type II (period-of-operation) audit.

**This is an engineering self-assessment, not a SOC 2 report.** A real report
requires an independent CPA firm, a defined audit period, and **organizational**
controls (policies, risk assessment, HR security, vendor management, access
reviews) that are management's responsibility and largely *outside the codebase*.
Those are listed as gaps, not claimed as done.

**Criteria in scope of this map:** the **Common Criteria (CC1–CC9 = the Security
category)**, plus **Availability (A1)** and **Confidentiality (C1)**. Processing
Integrity (PI) and Privacy (P) are noted as out-of-scope for this MVP cut.

**Status legend:** ✅ Implemented · 🟡 Partial · 🔴 Gap · 🏛 Organizational
(management action, not code)

---

## CC1 — Control Environment (governance)

| # | Criterion (abridged) | Status | Evidence / gap |
|---|---|---|---|
| CC1.1 | Integrity & ethics; code of conduct | 🏛 | Gap — needs a code of conduct + acknowledgements |
| CC1.2 | Board / governance oversight | 🏛 | Gap — no documented oversight body |
| CC1.3 | Org structure, authority, responsibility | 🟡🏛 | Partial — engineering ownership encoded in ADRs + `CODEOWNERS`-style review; formal org chart/roles gap |
| CC1.4 | Commitment to competence | 🏛 | Gap — onboarding/competency records |
| CC1.5 | Accountability | 🟡 | **Tamper-evident audit trail** attributes every action to an actor (ADR-0029); HR accountability process is a gap |

## CC2 — Communication & Information

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC2.1 | Quality information for internal control | ✅ | Structured logging + request/trace IDs (ADR-0010/0013), metrics (ADR-0014), append-only audit log (ADR-0029) |
| CC2.2 | Internal communication of responsibilities | 🟡 | ADRs (`docs/adr/`) + runbooks (`docs/runbooks/`) + audit docs; formal security-policy comms gap |
| CC2.3 | External communication | 🔴 | Gap — no published security/trust page, status page, or breach-comms plan |

## CC3 — Risk Assessment

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC3.1 | Objectives specified to enable risk ID | 🟡🏛 | ToR (`docs/ToR.md`) + module status matrix; formal control objectives gap |
| CC3.2 | Identify & analyse risk | 🔴🏛 | Gap — no risk register |
| CC3.3 | Fraud risk considered | 🔴🏛 | Gap |
| CC3.4 | Assess changes affecting controls | 🟡 | ADRs capture significant changes + consequences; formal change-risk review gap |

## CC4 — Monitoring Activities

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC4.1 | Ongoing / separate evaluations | ✅🟡 | Prometheus + Grafana + Loki + Tempo (ADR-0013/0014/0025/0026); **audit chain self-verification + Merkle anchor verify** (ADR-0029); periodic control self-assessment process is a gap |
| CC4.2 | Evaluate & communicate deficiencies | 🟡 | Alertmanager (5xx + stale-backup alerts, ADR-0026); deficiency-tracking workflow gap |

## CC5 — Control Activities

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC5.1 | Controls that mitigate risk | ✅ | RBAC (ADR-0019) + RLS tenant isolation (ADR-0002/0003) enforced in-DB |
| CC5.2 | Controls over technology | ✅ | `@Authorize` guard + permission catalog; CI gate (ADR-0005) |
| CC5.3 | Policies & procedures deployed | 🟡 | Controls are code-enforced; written policies (the "P" of P&P) are a gap |

## CC6 — Logical & Physical Access Controls **(core security)**

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC6.1 | Logical access security (identify, authenticate, authorize) | ✅ | Argon2id password hashing + JWT + refresh sessions (ADR-0002/0003); **RBAC** least-privilege (ADR-0019); **tenant isolation via Postgres RLS** two-GUC + FORCE RLS on every table |
| CC6.2 | Registration / provisioning of users | ✅🟡 | Admin user CRUD + role assignment (ADR-0022); self-service registration intentionally absent; joiner approval workflow is a gap |
| CC6.3 | Role-based authorization & least privilege | ✅ | Per-tenant roles + global permission catalog; API keys carry **≤-creator scopes** (no escalation, ADR-0054); bulk-import re-checks target-domain perm (ADR-0056) |
| CC6.4 | Physical access | 🏛 | Inherited from hosting provider (cloud) — needs the provider's SOC 2 + a vendor record |
| CC6.5 | Data/media disposal | 🟡 | Retention sweeper + legal hold (ADR-0050); soft-delete today, secure hard-purge is a gap |
| CC6.6 | Boundary protection | ✅🟡 | Caddy edge TLS + security headers + ops-endpoint block (ADR-0016); API-key quota + auth rate-limit (ADR-0009/0054); WAF gap |
| CC6.7 | Restrict transmission/movement of info | ✅🟡 | TLS in transit (ADR-0016); pre-signed scoped S3 URLs (ADR-0042); **mTLS service-to-service is a gap** (P4.7) |
| CC6.8 | Prevent/detect unauthorized software | 🟡 | Distroless non-root images (ADR-0017); Dependabot; container image scanning (Trivy) + SBOM are gaps |
| — | Multi-factor authentication | ✅ | TOTP MFA, encrypted secret at rest, backup codes, two-step login (ADR-0020) |
| — | Secrets management | 🟡 | Vault loader (ADR-0044, dev mode) + MFA-key in Vault; **production Vault (dynamic creds) is P4.7** |
| — | Key/credential storage | ✅ | Passwords (Argon2), API keys + reset tokens (SHA-256), MFA secret (encrypted) — never stored plaintext |

## CC7 — System Operations

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC7.1 | Detect config changes / vulnerabilities | 🟡 | Dependabot; SAST/DAST/CodeQL/ZAP + config-drift detection are gaps |
| CC7.2 | Monitor for anomalies / security events | ✅🟡 | Metrics + alerts (ADR-0014/0026); **SIEM export of the audit log (RFC 5424 / CEF)** (ADR-0030); a running SIEM + detection rules is a gap |
| CC7.3 | Evaluate security events | 🟡 | Audit explorer + alert routing partial; security-incident triage process gap |
| CC7.4 | Respond to incidents | 🟡 | Incident-response *workflow engine* (ADR-0046) + HA runbook; a **security** incident-response plan (IR runbook, severities, comms) is a gap |
| CC7.5 | Recover from incidents | 🟡 | Backups + restore drill (ADR-0012); HA (ADR-0058); DR plan + RTO/RPO targets are gaps |

## CC8 — Change Management

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC8.1 | Authorize, design, develop, test, approve, implement changes | ✅🟡 | CI (ADR-0005) + integration/e2e suites (ADR-0006/0007, 53 suites/386 tests) + ADR-per-change + versioned DB migrations (drizzle) + IaC (compose). Gaps: formal change-approval record, segregated **staging** env, release/rollback procedure |

## CC9 — Risk Mitigation

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| CC9.1 | Risk-mitigation (business disruption) | 🟡 | Backups + HA topology (ADR-0058); BCP/DR documentation gap |
| CC9.2 | Vendor & business-partner risk | 🔴🏛 | Gap — no vendor inventory / sub-processor list / vendor SOC 2 collection |

---

## Availability (A1)

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| A1.1 | Capacity management | 🟡 | DB pool metric + PgBouncer pooling (ADR-0058); capacity forecasting gap |
| A1.2 | Environmental protections, backup, recovery | ✅🟡 | Automated Postgres backups + retention + restore drill (ADR-0012); HA (scalable API, replica/Sentinel topology, ADR-0058); health probes (ADR-0015). DR/failover automation gap |
| A1.3 | Recovery testing | 🟡 | Backup→restore drill rehearsed (ADR-0012); periodic DR test schedule gap |

## Confidentiality (C1)

| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| C1.1 | Identify & protect confidential information | ✅🟡 | Tenant isolation (RLS), per-folder permission inheritance + grants (ADR-0048), encryption in transit (ADR-0016). **Data classification scheme is a gap**; encryption-at-rest is deploy/provider-dependent (SSE) — needs enforcement + record |
| C1.2 | Dispose of confidential information | 🟡 | Retention + legal hold (ADR-0050); secure hard-purge gap |

## Processing Integrity / Privacy

🔴 Out of scope for this MVP cut. If pursued: PI maps to input validation
(Zod contracts everywhere) + the import quarantine + audit; Privacy needs a
data-subject-rights workflow + DPA/records — not yet built.

---

## Gap summary — prioritized for SOC 2 readiness

**Technical (engineering can close):**
1. Encryption-at-rest enforcement + record (Postgres/MinIO SSE; document KMS).
2. mTLS service-to-service (P4.7) + production Vault dynamic credentials.
3. Security scanning in CI: SAST (CodeQL), dependency + container scan (Trivy), SBOM, DAST (ZAP).
4. Segregated **staging** environment + documented release/rollback + change-approval gate.
5. Running SIEM consuming the existing audit export + detection rules.
6. DR plan with RTO/RPO + scheduled DR test; secure hard-purge for disposal.
7. Automated **access reviews** (the `GET /rbac/me` + role data make this scriptable) + WAF at the edge.

**Organizational (management must own — 🏛):**
8. Information-security policy set (acceptable use, access control, change mgmt, incident response, BCP/DR, data classification, vendor mgmt, cryptography).
9. Risk register + annual risk assessment; vendor/sub-processor inventory with their SOC 2s.
10. HR security: onboarding/offboarding checklists, background checks, security training + acknowledgements.
11. Defined audit period, control owners, and the **evidence-collection cadence** (see `evidence-register.md`).

## Strengths to highlight to an auditor

A genuinely **tamper-evident, anchored audit trail** (hash-chain + WORM Merkle
anchor, ADR-0029) with **SIEM export** (ADR-0030); **DB-enforced tenant
isolation** (RLS, not app-layer); least-privilege **RBAC** + scoped API keys;
**MFA**; encrypted-at-rest secrets; backups with a rehearsed restore; and
full-stack observability. These are the hard-to-retrofit controls, and they're
already in place and tested.
