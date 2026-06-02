# ADR-0049: Document versioning (immutable versions + current pointer)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.4
**Depends on:** documents (P0.10/P2.12), folders + access (P3.3), StorageService

## Context

ToR §9.3: document versioning. Until now a `documents` row addressed a single
object — a re-upload would have to overwrite it, losing history. P3.4 adds an
immutable version history with rollback. Two points were confirmed with the
user: **explicit new-version upload** and **capture a content hash, separate
objects** (defer byte-level dedup).

## Decision

### `document_versions` child table + a current pointer

`document_versions` holds an immutable row per version (`version_no`,
`storage_key`, `size_bytes`, `etag`, `content_hash`, `mime_type`, `uploaded_by`).
`documents.current_version_no` points at the live one, and the document row keeps
**denormalising** that version's `storage_key`/`etag`/`size`/`mime_type` — so the
existing download / list / preview paths are unchanged (they always read "the
current bytes"). Tenant-isolated by RLS.

- **v1** is created when a document first becomes ready (in `finalize` /
  `completeMultipart`); pre-existing documents are **backfilled** to v1 in the
  migration. v1's object is the original key; later versions get a fresh key
  `…/documents/<id>/vN`.
- **New version**: `POST /documents/:id/versions` ({sizeBytes, mimeType?}) →
  presigned PUT to the fresh key; the pending version is stashed server-side in
  `documents.metadata.pendingVersion` (never trusted from the client, like
  multipart). `POST /documents/:id/versions/finalize` HEADs the object, records
  the version, and repoints the document (current + denormalised fields).
- **List / download / restore**: `GET /documents/:id/versions`;
  `GET /documents/:id/versions/:n/download-url` (presigned GET of that version's
  object); `POST /documents/:id/versions/:n/restore` repoints the current pointer
  to an old version (rollback — no new bytes, no new row).

### Content hash, separate objects

At finalize a best-effort **SHA-256** `content_hash` is computed server-side by
reading the object — only when its size is at/under `DOCUMENTS_HASH_MAX_BYTES`
(default 50 MiB) to bound API memory; larger objects get a null hash. Each
version is its own object (simple deletes). Real byte-level object sharing +
reference counting is deferred — the hash gives integrity + identical-content
detection without the delete-refcount hazard.

### Access

Version reads inherit the document's folder access (P3.3b — `getReadableOrFail`).
New-version upload / finalize / restore require write to the document's folder
(if filed). Endpoints stay on `document:read` / `document:write`; every version
add/restore is audited.

## Consequences

**Positive**
- Full, immutable version history with rollback; old versions remain
  downloadable byte-for-byte. The download/list/preview surface didn't change
  (denormalised current pointer).
- Content hashes give integrity + a foundation for future dedup.
- Verified end-to-end (real MinIO): v1+hash at finalize, new version bumps
  current, old versions intact, restore rolls back, unknown version 404.

**Negative / deferred**
- **No byte-level dedup** — identical content across versions/documents still
  stores duplicate objects (deferred: shared objects + refcount GC).
- **Hash capped by size** — objects over the cap get a null hash (no integrity
  fingerprint for very large files).
- **Old version objects are never GC'd** — deleting a document cascades the rows
  but a storage janitor for orphaned version objects is a follow-on.
- **No diff/compare** between versions; no per-version comment/label; no web UI.

## Validation

- **Suite**: 314/314, 41 suites (+4). `documents-versions` (real MinIO): v1 +
  content_hash at finalize; new version bumps `currentVersionNo`, list ordering,
  each version downloads its own bytes, current serves the latest, distinct
  hashes; restore repoints to v1 (no new row) and serves v1 bytes; unknown
  version → 404.
- **Build/lint**: contracts + db + API `tsc`, `nest build`, `eslint` clean.
  Migration `0023` (`document_versions` + `documents.current_version_no` + RLS +
  v1 backfill).
