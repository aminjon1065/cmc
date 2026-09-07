# Operations and Acceptance Specification

## 1. Load and Resource Modeling
The system targets a single on-premise server deployment.

**Engineering Assumptions (To Be Verified):**
- **Hardware:** Specific CPU/RAM/Disk and network bandwidth limits to be defined based on target hardware.
- **Concurrency:** Target number of simultaneous users, active analysts, and concurrent AV rooms/recordings.
- **Data Volume:** Target limits for dataset rows, GIS geometries, file sizes, and import batch sizes.
- **Performance:** P95 latency targets for key interactive operations (registry view, map load, search). Background job duration, memory limits, and backlog queue sizes.

*Note: All load tests must reflect combined usage (Analytics + GIS + Import + AV), not just isolated components.*

## 2. Failure Modes and Observability
**Resilience Testing:**
- Behavior when PostgreSQL, Redis, MinIO, GeoServer, or LiveKit are unavailable.
- Worker restarts during heavy imports or report generation (ensuring idempotency and no data corruption).
- Network loss, partial file uploads, and disk-full scenarios.
- One physical server remains a single point of failure (SPOF) for host/disk/power issues. Fast process restarts do not mitigate physical destruction.

**Observability:**
- Structured logs with correlation IDs. (No logging of passwords, tokens, or document contents).
- Prometheus metrics, readiness/liveness probes, and actionable alerts.
- Visibility into queue depths, hanging jobs, export/recording failures, free disk space, and backup freshness.
- No heavy observability platforms (e.g., full distributed tracing) unless load strictly dictates it.

## 3. Full Recovery Set (Disaster Recovery)
**Backup Scope:**
- PostgreSQL database dumps.
- MinIO objects, versions, and recordings.
- Required GIS resources and configuration.
- Audit chain anchors and encryption/recovery keys.

**DR Requirements:**
- Metadata and blob bytes must be consistent.
- Backups must be encrypted, retained according to policy, and stored off the primary host within a trusted network.
- Explicit mapping of normative RPO/RTO goals vs. configured thresholds vs. measured reality.
- **Validation:** A full restore drill on a clean, isolated environment must succeed, proving access, document retrieval, map rendering, and audit chain integrity.

## 4. Acceptance Criteria (AC)

- **AC-01. Import and Analytical Consistency:** Synthetically test imports with duplicates (skip policy). Verify counts match across registry, map, and reports, strictly filtered by region/role.
- **AC-02. Time, Corrections, and Reproducibility:** Verify timezone handling. Ensure fixed reports remain unchanged when source data updates, while live reports reflect changes.
- **AC-03. Spatial Calculation:** Verify intersection/bounding box queries against a known GeoJSON fixture. Confirm CRS validation and regional access limits.
- **AC-04. Prohibited Access:** Ensure isolated users cannot access restricted objects via list, ID, search, export, WMS, or WS subscriptions. Verify cache invalidation on role revocation.
- **AC-05. Full Web Login:** Complete flow with MFA setup, 2FA login, backup code usage (and rejection on reuse), and remote session revocation.
- **AC-06. Document Approval:** End-to-end EDMS flow: draft → register → route → return → v2 → route → approve → archive. Verify audit and concurrent modification protections.
- **AC-07. Files and Restoration:** Upload large file, interrupt/resume, create versions, move between ACL folders, soft-delete, and restore. Verify byte integrity and legal hold blocks.
- **AC-08. Task Delegation:** Supervisor assigns → employee accepts → submits result → supervisor returns → employee fixes → supervisor accepts. Verify org-chart boundaries.
- **AC-09. Private Communication:** DMs and closed channels. Reconnect and sync history. Verify evicted members stop receiving updates.
- **AC-10. Conference and Recording:** Two independent browser sessions connect via LiveKit. Start recording, stop, wait for confirmed readiness. Verify file download and robustness against restart.
- **AC-11. Full Restoration:** Backup a populated system, restore to a clean environment, and verify all major workflows (documents, maps, recordings, audit chain) function correctly.
- **AC-12. Autonomy and Combined Load:** Run analytics, GIS, and imports simultaneously. Disconnect external internet and verify local basemaps and functionality remain intact.
