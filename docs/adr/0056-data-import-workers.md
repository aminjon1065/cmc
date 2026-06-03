# ADR-0056: Bulk data-import workers — CSV/Excel→incidents, GeoJSON/Shapefile→GIS, per-row quarantine

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P3.11 (a: backend CSV/GeoJSON; b: Excel/Shapefile + web UI)
**Depends on:** gated BullMQ seam (P2.13 / ADR-0043), StorageService presign + bytes (P2.12), incidents (P1.5), GIS features (P2.7 / ADR-0037), RBAC (P1.1 / ADR-0019), audit (P1.11), tenant RLS (P0)

## Context

ToR §3.21 needs bulk import of operational data — legacy incident exports and
geospatial datasets. Two decisions were confirmed with the user:

1. **First targets: CSV→incidents + GeoJSON→GIS** (P3.11a); **Excel + Shapefile**
   follow (P3.11b). All four reduce to two target domains (tabular→incidents,
   spatial→GIS features), so the parser is swappable and the target pipeline is
   shared.
2. **Per-row validation with partial-commit + a quarantine table** — NOT
   all-or-nothing. A bad row is set aside with a reason; the good rows still land.
   This is what "validation + quarantine" means for an operator re-importing a
   messy file.

## Decision

### Data model (migration 0030)

`import_jobs` (kind, `source_key`, `target_id`, status, `total/inserted/failed`
counts, `error`, `created_by`, timestamps) + `import_row_errors` (the quarantine:
`job_id`, 1-based `row_num`, `reason`, `raw` jsonb of the offending row). Both
carry the two-GUC RLS policy + FORCE RLS.

### Async pipeline (gated seam, like previews)

`IMPORT_QUEUE` (DI token) resolves to a real BullMQ queue only when
`IMPORTS_ENABLED`, else a Noop — the real impl is dynamic-imported so `bullmq`
never loads under jest. `ImportWorker` (skipped when `NODE_ENV=test`) consumes the
queue and calls `ImportService.runJob`. The heavy parsers (`xlsx`, `shapefile`,
`adm-zip`) are likewise dynamic-imported, so they load only when that kind runs.

### The source is an uploaded object, not an inline body

`POST /v1/imports/upload-init` presigns a PUT to `imports/<tenant>/<uuid>-<name>`
(no document row — transient source); the browser PUTs the file straight to
MinIO; then `POST /v1/imports {kind, sourceKey, targetId?}` records the job. This
reuses the platform's presigned-upload posture (P2.12) and keeps large/binary
files off the API request path.

### Parse → validate → partial-commit → quarantine

`runJob` is split into **parsers** (bytes → raw rows/features; never touch the
DB) and **processors** (validate + insert + quarantine):

- CSV (`csv-parse`) and **Excel** (`xlsx`, first sheet, `raw:false` so cells are
  strings like CSV) both produce `Record<string,string>[]` → `processIncidentRows`
  validates each against **`CreateIncidentRequestSchema`** (zod).
- GeoJSON (native JSON) and **Shapefile** (`adm-zip` → `shapefile.read` on the
  `.shp`/`.dbf`) both produce GeoJSON features → `processGisFeatures` validates
  the geometry structurally then inserts via `ST_GeomFromGeoJSON`. Shapefile
  coords are taken as **WGS84** (reprojection/proj4 is a future enhancement).

The crucial mechanic: the whole pass runs in **one `runForTenant` transaction**,
and **each row insert is wrapped in a SAVEPOINT** (`tx.transaction`). A row that
throws (bad geometry, constraint) rolls back only its savepoint and is
quarantined — it cannot abort the job (a failed statement poisons a Postgres tx,
so without savepoints partial-commit is impossible). Valid rows + quarantine rows
+ final counts/status commit atomically.

### Safety

- **No RBAC escalation**: the endpoint is `@Authorize("import:run")`, but
  `create` *additionally* checks the **target-domain** write perm
  (`incident:create` / `gis_feature:write`) via `RbacService` — a key/role with
  `import:run` but not the domain perm gets 403.
- **No double-import on retry**: `runJob` claims the job with a compare-and-set
  (`UPDATE … SET status='processing' WHERE status='queued' RETURNING`). Only one
  attempt wins; a not-yet-visible row (enqueue-before-commit race) throws so the
  BullMQ retry re-attempts. `IMPORT_MAX_ROWS` caps a job (truncation noted on the
  job, never silent).

### Web (P3.11b)

`/imports` (sidebar "Data Import", middleware-protected): a job table (status,
inserted/total, quarantined, expandable quarantine viewer) + a "New import" form
— pick kind, pick a target GIS layer for spatial kinds, choose a file; the client
runs upload-init → presigned PUT → create, via `"use server"` actions.

## Consequences

- **Good**: one async pipeline serves four formats and two domains; adding a
  format is a parser, not a vertical. Quarantine gives operators actionable
  per-row feedback. The seam keeps `bullmq`+heavy parsers out of the test runtime.
  DB-enforced tenant isolation throughout.
- **Trade-offs / deferred**: Shapefile assumes WGS84 (no proj4 reprojection);
  Excel reads only the first sheet with a fixed incident column mapping (no
  user-defined field mapping yet); no export side, no scheduled/CDC ingestion, no
  dedupe/upsert (every valid row inserts). Imports are not resumable — a worker
  crash mid-job leaves it `processing` (no double-insert, but stuck); a reaper is
  future work.

## Validation

- **e2e** (`imports.e2e-spec` 8/8): CSV + XLSX partial-commit + quarantine;
  GeoJSON + Shapefile (real hand-built `.shp` zip) feature import; upload-init →
  presigned PUT → import round-trip; whole-file failure (missing source); contract
  400 (gis kind without target); RBAC (viewer 403) + **escalation guard**
  (import:run without incident:create → 403) + cross-tenant 404. Full suite **52
  suites / 378 tests**, zero regressions. Migration 0030.
- **Live smoke** (`imports-worker.live-smoke`, real BullMQ + Redis + MinIO,
  `IMPORTS_ENABLED=true`): HTTP create → enqueue → worker → runJob → Postgres,
  job completed.
- **Web**: `tsc` + `next lint` + `next build` clean; `/imports` 307→`/login`
  unauthenticated, `/login` 200, server log clean.
