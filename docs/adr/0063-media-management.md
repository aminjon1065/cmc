# ADR-0063: Media management — gated ffmpeg→HLS transcode, BFF stream proxy, burned-in watermark

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.5 (a — substrate; b — web + HLS player; c — watermarking + close)
**Depends on:** documents/S3 (P1 + P2.12), RBAC (P1.1), gated BullMQ seam (P2.13), BFF posture, RLS

## Context

ToR §3.24 wants media management: uploaded video/audio made streamable, with
adaptive playback in the browser and an optional watermark for confidential
footage (incident clips, briefings, evidence). The platform already stores
arbitrary files as **documents** in S3 (MinIO), so media is best modelled as a
*derived layer over an existing document* rather than a new upload path.

Three constraints shaped the design:

1. **No JWT in the browser** (BFF posture). An HLS player fetches a playlist plus
   many segments; none of those requests may carry the access token, and each must
   still be RBAC-checked.
2. **ffmpeg is heavy and non-deterministic** — it cannot run in the headless
   implement·test·validate cycle. The transcode path must be gated off in tests
   while the asset model + streaming proxy stay fully e2e-testable.
3. **Watermarking** must be tamper-resistant: a CSS overlay in the player is
   trivially removed, so the mark has to be *burned into the pixels* at transcode.

## Decision

### 1. `media_assets` as a derived layer over documents (P4.5a)

A `media_assets` row (migration 0037; `watermark` added in 0038) references a
source `documents` row (FK, cascade) and tracks `kind` (video/audio),
`status` (pending→processing→ready/failed), `playlistKey`/`posterKey` in S3,
`durationSec`, `watermark`, and `error`. RLS-scoped to the tenant; indexed by
document and status. The source bytes are never duplicated — only the HLS
rendition is produced under `media/<tenant>/<asset>/`.

### 2. Gated BullMQ transcode seam → ffmpeg→HLS→S3 (P4.5a)

Reusing the P2.13 gated-lazy-seam pattern: a `MEDIA_QUEUE` token with a
`NoopMediaQueue` (default) and a `RealMediaQueue` (dynamic-imports `bullmq`),
chosen by an async factory gated on `MEDIA_TRANSCODE_ENABLED`. The
`media-transcode` worker is `isTest`-skipped. `MediaService.transcode()` (worker
path only, `runPrivileged`) downloads the source, shells out to **ffmpeg** to
produce VOD HLS (`-hls_time`, configurable `MEDIA_HLS_SEGMENT_SECONDS`), grabs a
first-frame **poster** (best-effort), uploads playlist + segments + poster to S3,
and flips the row to `ready` (or `failed` with a truncated error). In tests the
queue is a noop and ffmpeg never runs.

### 3. BFF HLS proxy — playlist rewrite + segment byte-proxy (P4.5a/b)

The browser streams **same-origin** with no token. Two API routes, both
`@Authorize("media:read")` and RLS-scoped:

- `GET /assets/:id/playlist.m3u8` — fetches the `.m3u8` from S3 and **rewrites
  every segment URI to `seg/<name>`** so each segment resolves back to the proxy.
- `GET /assets/:id/seg/:name` — proxies that segment's bytes from S3 as a
  `StreamableFile` (`video/mp2t`). The name is validated against `SEGMENT_RE`
  (no path traversal). *(Returning a raw `Buffer` would be JSON-wrapped by Nest —
  `StreamableFile` is required for binary.)*

On the web side, mirror BFF routes `/api/media/[id]/playlist.m3u8` +
`/api/media/[id]/seg/[name]` attach the bearer **server-side** before calling the
API; `hls.js` (with native-HLS fallback) plays the proxied playlist. The access
JWT stays server-side end-to-end.

### 4. Burned-in text watermark (P4.5c)

`CreateMediaTranscodeSchema` takes an optional `watermark` (≤100 chars), stored on
the asset. When set, `transcode()` adds an ffmpeg `drawtext` filter
(`-vf drawtext=…`) that burns the text into the bottom-left of every frame
(semi-transparent white on a dark box). The text is **shell-escaped for the
filtergraph** (`\`, `'`, `:`, `%`), and an optional `MEDIA_WATERMARK_FONT` points
ffmpeg at a `fontfile` (drawtext needs a font; default empty → ffmpeg's built-in).
Because the mark is in the pixels, it survives download and screen-capture —
unlike a player overlay.

### 5. A dedicated `media:*` permission pair

`media:read` (stream + list) and `media:write` (request transcode), granted to
operator + tenant_admin; auditor gets `media:read`. A clean gate for the whole
surface rather than overloading `document:*`.

## Consequences

- **Positive:** media reuses existing document storage (no new upload path); the
  heavy ffmpeg path is fully isolated behind a gated seam and never runs in CI;
  the asset model + HLS proxy are e2e-tested against real Postgres + MinIO; the
  player never holds a token; watermarks are tamper-resistant.
- **Negative / trade-offs:** real ffmpeg→HLS is a **manual/live boundary** (not
  headless-tested); single-rendition VOD HLS (no multi-bitrate ABR ladder yet);
  watermark is a fixed bottom-left text style (no per-tenant positioning/logo);
  the segment proxy adds a hop vs. presigned URLs — chosen deliberately so every
  segment is RBAC-checked and the JWT stays server-side.

## Validation

- e2e `media` **4/4**: transcode→pending + list/get; RBAC 403 + unknown-doc /
  cross-tenant 404; **watermark round-trip** (provided → stored, omitted → null);
  HLS proxy playlist-rewrite + segment bytes + invalid-name 400 + cross-tenant
  404 (proxy driven against seeded HLS in MinIO). Full backend suite
  **57 suites / 416 tests**, zero regressions. `tsc`/`eslint` clean.
- Web `tsc`/`lint`/`build` green; smoke `/media`→307 login + playlist proxy→401.
- **Boundary (manual/live):** real ffmpeg transcode + watermark burn-in verified
  by running with `MEDIA_TRANSCODE_ENABLED=true` and an ffmpeg-equipped worker —
  not part of the headless suite.

## Files

- Backend: `apps/api/src/modules/media/` (`media.service.ts`, `media.controller.ts`,
  `media.queue.ts`, `media-queue.impl.ts`, `media.worker.ts`, `media.module.ts`),
  `packages/db/src/schema/media-assets.ts` (+ migrations 0037, 0038),
  `packages/contracts/src/media.ts`, `media:*` in the RBAC catalog,
  `MEDIA_TRANSCODE_ENABLED` / `MEDIA_HLS_SEGMENT_SECONDS` / `MEDIA_WATERMARK_FONT`
  config.
- Web: `apps/web/src/app/media/` (`page.tsx`, `media-workspace.tsx`,
  `media-player.tsx`, `actions.ts`), BFF routes
  `apps/web/src/app/api/media/[id]/playlist.m3u8/route.ts` +
  `apps/web/src/app/api/media/[id]/seg/[name]/route.ts`; "Media" sidebar entry +
  middleware.

## Follow-ons

- Multi-bitrate ABR ladder (renditions + master playlist) for varied bandwidth.
- Document-picker integration on the documents page (today a document ID is
  entered directly).
- Per-tenant watermark presets (logo image, position, opacity).
- Audio-only waveform poster; subtitle/caption sidecar tracks.
- Lifecycle/retention of derived HLS renditions (reuse §3.5 retention sweeper).
