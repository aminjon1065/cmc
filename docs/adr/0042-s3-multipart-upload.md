# ADR-0042: S3 multipart upload (resumable large files)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.12
**Depends on:** documents module (P0.10), StorageService

## Context

The single-PUT upload flow (P0.10) caps at ~5 GB and isn't resumable. P2.12 adds
large-file + resumable uploads (ToR §15.8).

## Decision

### S3 multipart, API-orchestrated — not a tus.io server

The plan suggested a tus.io protocol server. We chose **API-orchestrated S3
multipart** instead (confirmed with the user): it extends the existing
presigned-URL + MinIO + documents-row pattern, adds no new protocol surface, and
is fully testable in CI. (A full tus.io server — `@tus/server` + `@tus/s3-store`
— would match the wording but is a heavy NestJS/Express integration that's hard
to verify here; left as a future alternative.)

### Flow

1. `POST /v1/documents/multipart/init` ({name, mimeType, sizeBytes}) — inserts the
   `documents` row (status `uploading`), `CreateMultipartUpload` on MinIO, and
   returns the `uploadId`, `partSize`, and a **pre-signed `UploadPart` URL per
   part** (count = ⌈sizeBytes / partSize⌉).
2. The client PUTs each part directly to its pre-signed URL (a failed part is
   simply re-PUT — that's the resumability), collecting the part `ETag`s.
3. `POST /v1/documents/:id/multipart/complete` ({parts:[{partNumber, etag}]}) —
   `CompleteMultipartUpload` assembles the object; the row flips to `ready` with
   the real size/etag (verified via HEAD).
4. `POST /v1/documents/:id/multipart/abort` — `AbortMultipartUpload` frees the
   staged parts; the row is marked `failed`.

### uploadId is server-trusted

The `uploadId` is persisted in `documents.metadata.multipart` at init and read
back on complete/abort — the client never supplies it (it only rides inside the
signed part URLs). All routes are `document:write`, tenant-scoped by RLS, and
ownership-checked (`uploadedBy`). `partSize` is configurable
(`DOCUMENTS_MULTIPART_PART_SIZE`, default 8 MiB; S3 floor 5 MiB).

## Consequences

**Positive**
- Large files (beyond the single-PUT limit) + resumable part retries, on the
  existing stack — no new infra, no new protocol.
- Bytes flow **client → MinIO** directly (the API only signs + orchestrates);
  the access token never touches the part PUTs.
- Verified live + in CI: a >5 MiB file uploaded across two parts assembles and
  downloads byte-for-byte; abort works.

**Negative / deferred**
- **Not the tus.io protocol** — clients integrate against our 3 endpoints, not a
  standard resumable protocol (Uppy/tus clients would need an adapter).
- **Resume needs the client to remember part state** — no server `ListParts`
  endpoint yet to re-derive which parts already landed.
- **No per-part checksum verification** (relies on S3 ETags); no automatic GC of
  abandoned multipart uploads (a lifecycle rule / janitor is a follow-on).
- No web UI wired to it yet.

## Validation

- **Suite**: 271/271, 35 suites. `documents-multipart` (4): single-part upload +
  download round-trip; **>5 MiB two-part** upload (real MinIO) + download
  byte-count; abort → `failed`; RBAC (role-less → 403).
- **Live smoke** (booted API): init → pre-signed part PUT (200 + ETag) →
  complete (`ready`, 1000 B) → download 1000 B.
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration
  (uses `documents.metadata`).
