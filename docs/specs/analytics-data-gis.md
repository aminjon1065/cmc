# Analytics, Data, and GIS Specification

## 1. Data Model and Catalog
The platform centers around a core set of analytical datasets. The primary starting point is **Incidents**; others (infrastructure, risk zones, etc.) may follow.

**Data Requirements:**
- Stable ID, title, description, owner, and access scope.
- Strongly typed schema (mandatory fields, units, references/dictionaries).
- Source and ingestion method.
- Event date/time distinctly separate from ingestion timestamp.
- Data freshness and quality status.
- Origin, version history, and audit trail for reproducibility.
- Identifiers for spatial (GIS) relations, documents, and other domain objects.
- Clear rules for modification and deletion (e.g., how corrections affect existing reports).

**Scope:** The MVP uses a fixed set of registries with typed schemas, rather than allowing arbitrary schema-less JSON definitions.

## 2. Single Ingestion Pipeline
A unified flow for bringing external data (CSV/XLSX) into the analytical model:
`Upload -> Preview -> Column Mapping -> Validation -> Confirmation -> Result Report`

**Ingestion Rules:**
- Support for CSV and XLSX (specifying sheet, encoding, delimiter, dates, and decimals).
- Reusable column mappings.
- Server-side validation of types, required fields, ranges, and access scopes.
- Ownership is determined by a trusted rule (e.g., the user's region), not blindly read from a text field to grant access to other regions.
- Duplicate policy: Reject, Skip, or Update by stable key. No automatic fuzzy merging.
- Explicit atomic or partial batch commits (users see created, updated, skipped, rejected counts).
- Row-level error reporting with clear reasons, protected by the same access scope as the source.
- Idempotency for retries and workers. Re-uploading a modified file behaves predictably.
- Full audit log identical to manual data entry.
- Safe processing of archives, paths, formulas, and large files (memory limits, no unbound full-file reads).

## 3. Data Quality and Corrections
It must be clear what data is accepted, rejected, pending review, or stale. Modifying a record preserves the source and author. 
**Report Impact:** Modifying a record after a report is published dictates whether the report is a live view (re-calculates) or a fixed document (stays as-is).

## 4. Analyst Workspace & Metrics
**Data Exploration:**
- Server-side filtering, sorting, and pagination.
- Column selection and saved views.
- Grouping, pivot tables, and numerical/categorical/temporal filters.
- Seamless navigation from aggregate metrics to source rows.
- Filter synchronization between tabular views and the map.
- Clear UI states (empty, loading, error, partial, stale).
- Heavy calculations run in the background with progress and cancellation.

**Metrics Catalog:**
- Each metric defines: formula, unit, dimensions, time field, timezone, filters, version, and owner.
- Explicit handling of duplicates, late arrivals, corrections, and deletions.
- Initial metrics focus on verifiable counts (incident volume, distributions).
- Custom expressions use a restricted AST/allow-list. No arbitrary JS/SQL execution.

**Dashboards:**
- Core widgets: metric card, time series, distribution chart, table, map.
- Saved parameters, global filters, author/reader access control.

## 5. Reports and Export
- Generate, view, and export PDF/XLSX based on templates.
- Distinguish between "live" reports and "fixed" published snapshots.
- Preserve parameters, build time, data freshness, and definitions to ensure reproducibility.
- Serve files only to users with current, valid access.
- Scheduled reports execute under the owner's access scope.
- Protect exported XLSX from formula injections.

## 6. GIS and Spatial Analysis
**Unified Spatial Data (PostGIS):**
- Layers define attribute schema, geometry type, CRS, source, freshness, precision, version, style, and rights.
- Geographic location is distinct from organizational ownership (e.g., HQ can input data for a region, with defined access rules).
- Geometry import must respect original CRS; `ST_Transform` is used, not just `ST_SetSRID`. Unsupported CRS yields a clear error.
- Geometry validity and limits are enforced.

**Web and Desktop GIS:**
- **Web Map:** Layer groups, toggles, ordering, opacity, legend, feature inspection, spatial/temporal filters synced with data tables.
- **Access:** MVT, WMS, and WFS respect the user's security scope. WMS/GeoServer proxying must securely filter features by user permissions, not just trust the client's filters.
- **Desktop (QGIS/ArcGIS):** Documented authentication and access boundaries.

**Applied Operations (MVP):**
- Filter by bounding box/zone.
- Intersect features with a zone.
- Aggregate metrics by territory.
- Navigate from spatial analysis results back to table rows.

**Autonomy:**
- Support offline mode with local basemaps, styles, and fonts if outbound internet is disabled.

