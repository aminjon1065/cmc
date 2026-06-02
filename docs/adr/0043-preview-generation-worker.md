# ADR-0043: Preview generation worker (thumbnails)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P2.13 (P2.13a + P2.13b)
**Depends on:** documents module (P0.10), StorageService, Redis (P0.2)

## Context

Document lists and detail views are far more useful with thumbnails. P2.13 adds
asynchronous preview generation: when an upload is finalized, a job is enqueued;
a worker downloads the original, renders a small preview, stores it back in
object storage, and records its key on the document so the UI can request a
signed preview URL.

This was delivered in two cycles:
- **P2.13a** — the queue seam, image preview rendering, and finalize wiring.
- **P2.13b** — the BullMQ worker that consumes the queue, the
  `GET /v1/documents/:id/preview-url` endpoint, and `previewKinds` on the
  document contract.

## Decision

### Gated-lazy queue seam (BullMQ), like NATS/ClickHouse

`PREVIEW_QUEUE` is a DI token with a `PreviewQueue` interface, a `NoopPreviewQueue`
(default), and a `RealPreviewQueue` (BullMQ). The async factory dynamic-imports
the real impl **only when `PREVIEWS_ENABLED`** — so `bullmq`/`ioredis` never enter
the jest runtime when previews are off (the established gated-lazy-seam pattern).
Tests override the token with a capturing fake.

`PreviewService.enqueue(tenantId, documentId)` is called from **finalize** and
**multipart-complete**, best-effort: enqueue failures are logged, never thrown, so
a preview backlog can never break an upload. The job payload carries the
`tenantId` (`PreviewJob { tenantId, documentId }`) because the worker runs
outside any request context and has no ambient tenant.

### Worker: gated, dynamic-imported, runs `generatePreview`

`PreviewWorker` (`OnModuleInit`/`OnModuleDestroy`) is gated on
`PREVIEWS_ENABLED && !isTest`; it dynamic-imports `bullmq`'s `Worker` + `ioredis`
and processes jobs by calling `PreviewService.generatePreview(tenantId, documentId)`.
`generatePreview` loads the **ready** document under the job's tenant
(`runForTenant`), renders, stores, and records the preview key.

### Image previews via sharp → WebP; other kinds deferred

Images are resized (`PREVIEW_MAX_DIM`, fit `inside`, no enlargement) to WebP via
`sharp` (dynamic-imported), stored at `previews/<storageKey>.webp`, and the key is
merged into `documents.metadata.previews` (`{ image: <key> }`). PDF/video/audio
are recognised but **skipped with a log** until their toolchains (poppler/ffmpeg)
exist in the runtime image.

### Read path: previewKinds + signed preview URL

The document contract gains `previewKinds: string[]` (derived from
`metadata.previews` keys) so the UI knows which previews exist without a second
call. `GET /v1/documents/:id/preview-url` (`document:read`) returns a short-lived
pre-signed GET for the image preview (`image/webp`), or **404** when none exists —
mirroring `download-url`, tenant-scoped by RLS.

## Consequences

**Positive**
- Thumbnails on the existing stack — no new infra (BullMQ rides the existing
  Redis). With previews off (dev/test default) nothing heavy loads.
- Uploads never block on or fail because of preview generation.
- Verified live: a finalized PNG is picked up by the real worker, rendered to
  WebP, recorded, and served via a signed URL that returns valid WEBP bytes.

**Negative / deferred**
- **Image only.** PDF/video/audio need poppler/ffmpeg in the runtime image
  (recognised + logged, not generated).
- **No retry visibility / dead-letter UI** beyond BullMQ's `attempts`/backoff.
- **No backfill** for documents uploaded before previews were enabled (a janitor
  that enqueues missing previews is a follow-on).
- No web UI wired to `preview-url` yet.

## Validation

- **Suite**: 274/274, 36 suites (+1). `previews` (3): finalize enqueues (faked
  queue) + a PNG renders a real WebP (RIFF) recorded in metadata **and** surfaced
  via `previewKinds` + `preview-url` (the signed URL fetches WEBP bytes);
  `preview-url` → **404** when no preview; non-image kind skipped.
- **Live smoke** (`PREVIEWS_ENABLED=true` + Redis): boot → worker logs
  `consuming cmc-previews` → finalize a PNG → poll until `previewKinds:["image"]`
  (real BullMQ worker) → `preview-url` fetches a valid WEBP (RIFF/WEBP magic).
- **Build/lint**: API `tsc` + `nest build` + `eslint` clean. No migration
  (uses `documents.metadata`).

## Notes / gotcha

BullMQ **forbids `:` in queue names** (it's the Redis key separator) and only
throws when the real queue is constructed — invisible to the (queue-faked) test
suite. Caught by the live smoke; the queue name is `cmc-previews` (hyphen).
